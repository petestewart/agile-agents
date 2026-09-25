/**
 * `AttachService` against the real `fake-agent.ts` over a real ACP
 * transport — no vendor, no login, no network. Everything the acceptance
 * criteria name: a no-repo attach, a repo attach, the exit path, the
 * one-worker rule, the effort-ignored line, and `ask` reaching the inbox
 * and the answer reaching the session.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACP_PROVIDERS,
  type AcpProviderConfig,
  type SpawnSessionOptions,
  spawnSession,
} from '@agile-agents/acp-client';
import {
  AGENT_LINE_MAX_CHARS,
  type HilId,
  type Policy,
  type Question,
  type Stream,
} from '@agile-agents/shared';
import { GateService } from '../gates/service';
import { runInit } from '../init';
import { LandingService } from '../landing/service';
import { EMPTY_TREE_SHA } from '../permissions/git-env';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import { wireQuestionSupersession } from '../questions/supersede';
import type { FakeAgentScript } from '../runner/fake-agent';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { buildAttachRpcMethods } from './rpc';
import { sayPrompt } from './service';
import { AttachService, StreamBusyError, endedReason } from './service';
import { VerbService } from './verbs';

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

let home: string;
let repo: string;
let scratch: string;
let store: StateStore;
let streams: StreamService;
let questions: QuestionService;
let verbs: VerbService;
let attachService: AttachService;
let gates: GateService;

function git(args: string[], cwd = repo): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

/** A provider entry whose *transport* is `fake-agent.ts` but whose registry fields are the real vendor's. */
function fakeProviderFor(vendor: AcpProviderConfig, script: FakeAgentScript): AcpProviderConfig {
  const scriptPath = join(scratch, `${Bun.hash(JSON.stringify(script)).toString(36)}.json`);
  writeFileSync(scriptPath, JSON.stringify(script));
  return {
    ...vendor,
    command: 'bun',
    args: [FAKE_AGENT_PATH],
    envOverrides: { AGILE_FAKE_AGENT_SCRIPT: scriptPath },
  };
}

const SPEAKS: FakeAgentScript = {
  steps: [{ type: 'agent_text', text: 'looking at the parser now' }, { type: 'end_turn' }],
};

/**
 * Hangs *inside* the turn after speaking, so a test can assert on a live
 * session. The `tool_call` is what closes the streaming message, so the
 * spoken line reaches the thread without the turn ending — a turn that
 * ended with no open question would now stop the session (T137).
 */
const SPEAKS_THEN_HANGS: FakeAgentScript = {
  steps: [
    { type: 'agent_text', text: 'looking at the parser now' },
    { type: 'tool_call', toolCallId: 'read-1', title: 'read parser.ts' },
    { type: 'hang' },
  ],
};

/**
 * Wired the way `daemon.ts` wires it: the attach service asks the question
 * service what is still open (the turn-end rule), and the question service
 * delivers an answer by prompting the live session. Both sides are read
 * lazily so a test may rebuild either one.
 */
function buildAttachService(
  provider: AcpProviderConfig,
  spawn?: typeof spawnSession,
): AttachService {
  return new AttachService({
    store,
    streams,
    home,
    provider: () => provider,
    questions: { listOpen: () => questions.listOpen() },
    gates: { list: () => gates.list() },
    ...(spawn !== undefined ? { spawn } : {}),
  });
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 20_000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met in ${timeoutMs}ms`);
    await Bun.sleep(intervalMs);
  }
}

function threadBodies(streamId: string): string[] {
  return streams.readThread(streamId, { limit: 500 }).entries.map((entry) => entry.body);
}

async function makeStream(repoName?: string): Promise<Stream> {
  return streams.create('human', {
    title: 'CSV parser',
    goal: 'decide the dialect and implement it',
    ...(repoName !== undefined ? { repo: repoName } : {}),
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-attach-home-'));
  scratch = mkdtempSync(join(tmpdir(), 'agile-attach-scratch-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-attach-repo-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);

  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  questions = new QuestionService(store, streams, {
    deliver: (sessionId, question) => attachService.deliverAnswer(sessionId, question),
  });
  verbs = new VerbService({ store, streams, questions });
  gates = new GateService(store);
  // T145: wired exactly as `daemon.ts` wires it — deciding a gate closes
  // whatever question the same session still has open.
  wireQuestionSupersession(gates, questions);
  attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS));
});

afterEach(async () => {
  await attachService.stopAll();
  await store.flush();
  store.close();
  for (const dir of [home, repo, scratch]) rmSync(dir, { recursive: true, force: true });
});

describe('attach on a stream with no repo (a planning conversation)', () => {
  test('streams the session output onto the thread and touches no git', async () => {
    // A non-git temp dir is the whole point: if anything in the attach path
    // reached for git, it would have to reach for *this* directory.
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);

    expect(session.role).toBe('worker');
    expect(session.vendor).toBe('claude');
    expect(session.worktree).toBeUndefined();

    await waitFor(() => threadBodies(stream.id).some((b) => b.includes('looking at the parser')));
    const entry = streams
      .readThread(stream.id, { limit: 500 })
      .entries.find((e) => e.body.includes('looking at the parser'));
    expect(entry?.by).toBe(`agent:${session.id}`);
    expect(entry?.kind).toBe('line');
    // The untruncated text is on disk, and the thread line points at it.
    expect(readFileSync(entry?.ref ?? '', 'utf8')).toContain('looking at the parser');

    expect(streams.get(stream.id).branch).toBeUndefined();
    expect(streams.get(stream.id).worktree).toBeUndefined();
    expect(existsSync(join(home, '.git'))).toBe(false);
  });
});

describe('attach on a stream with a repo', () => {
  test('creates the worktree, runs the session in it, and ignores .worktrees/', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const stream = await makeStream('demo');
    const { session, stream: updated } = await attachService.attach(stream.id);

    expect(session.worktree).toBe(updated.worktree ?? '');
    expect(updated.worktree?.startsWith(join(repo, '.worktrees'))).toBe(true);
    expect(existsSync(join(updated.worktree ?? '', 'README.md'))).toBe(true);
    expect(updated.branch).toBeDefined();
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.worktrees/');
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);

    // The session's own cwd *is* that worktree: its hook settings are
    // written there, which is what the hook path resolves a call through.
    await waitFor(() => existsSync(join(updated.worktree ?? '', '.claude', 'settings.json')));

    // While it is live, the registry entry places that cwd on this stream.
    const registered = store.listAgents().find((a) => a.id === session.id);
    expect(registered?.record.stream).toBe(stream.id);
    expect(registered?.record.worktree).toBe(updated.worktree);
    expect(registered?.record.role).toBe('worker');
  });
});

describe('T207: both .claude settings files tracked', () => {
  test('attach is refused before the stream is marked working or a session recorded', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n');
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{}\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'settings']);
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const stream = await makeStream('demo');
    await expect(attachService.attach(stream.id)).rejects.toThrow('tracks both');
    const after = streams.get(stream.id);
    expect(after.agent.status).not.toBe('working');
    expect(after.sessions ?? []).toEqual([]);
  });
});

describe('the exit path', () => {
  test('writes agent.status done, the session status, and a thread entry', async () => {
    const stream = await makeStream();
    const { session, handle } = await attachService.attach(stream.id);
    expect(streams.get(stream.id).agent.status).toBe('working');

    // Stopping is the operator's `agile detach`: SIGTERM, escalating to
    // SIGKILL after the client's own grace period.
    handle.stop();
    await handle.exited;
    await waitFor(() => streams.get(stream.id).agent.status === 'done');

    const after = streams.get(stream.id);
    expect(after.sessions.find((s) => s.id === session.id)?.status).not.toBe('running');
    expect(threadBodies(stream.id).some((b) => b.startsWith('session ended:'))).toBe(true);
    // The registry entry is gone, so the hook can no longer resolve a cwd
    // to a session that has exited.
    expect(store.listAgents().some((a) => a.id === session.id)).toBe(false);
  }, 20_000);
});

describe('a detach that loses the race to a failed turn', () => {
  test('ends the session as stopped even when the exit path reports ok: false', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => streams.get(stream.id).agent.status === 'working');

    // Force the ordering CI hit: the kill rejects the in-flight prompt, so
    // `finish('prompt failed: …', false)` resolves `exited` before the
    // process exit's clean `ok: true` can.
    const service = attachService as unknown as {
      onExit: (...args: [string, string, string, boolean, ...unknown[]]) => Promise<void>;
    };
    const original = service.onExit.bind(attachService);
    service.onExit = (streamId, sessionId, _reason, _ok, ...rest) =>
      original(streamId, sessionId, 'prompt failed: session stopped', false, ...rest);

    expect(await attachService.stop(stream.id, 'worker', { detach: true })).toEqual([session.id]);
    const after = streams.get(stream.id);
    expect(after.sessions.find((s) => s.id === session.id)?.status).toBe('stopped');
    expect(after.agent.status).toBe('idle');
    expect(threadBodies(stream.id)).toContain('worker detached by human');
  }, 20_000);
});

describe('a session that dies on a vendor error (T171)', () => {
  test("the session record carries the vendor's error line for the sessions strip", async () => {
    // A vendor that prints its complaint and then refuses the session's
    // mode — the offline stand-in for "does not support this model".
    const vendorLine =
      'Claude Code 2.1.257 does not support this model; version 2.1.280 or newer is required';
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        stderrBanner: `starting\n${vendorLine}`,
        validModes: ['nope'],
        steps: [{ type: 'end_turn' }],
      }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => {
      const ref = streams.get(stream.id).sessions.find((s) => s.id === session.id);
      return ref?.status === 'error' && ref.ended_reason !== undefined;
    });
    const ref = streams.get(stream.id).sessions.find((s) => s.id === session.id);
    expect(ref?.ended_reason).toContain(vendorLine);
  }, 20_000);

  test('endedReason: nothing on a clean end, the vendor line appended once, capped', () => {
    expect(endedReason('process exited (code 0)', true, undefined)).toBeUndefined();
    expect(endedReason('prompt failed: boom', false, 'boom')).toBe('prompt failed: boom');
    expect(endedReason('process exited (code 1)', true, 'bad model')).toBe(
      'process exited (code 1): bad model',
    );
    expect(endedReason('x', false, 'y'.repeat(400))?.length).toBe(300);
  });
});

describe('one live worker per stream (§2.3)', () => {
  test('a second attach is refused while the first is live', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const stream = await makeStream();
    await attachService.attach(stream.id);
    await waitFor(() => streams.get(stream.id).sessions.some((s) => s.status === 'running'));

    await expect(attachService.attach(stream.id)).rejects.toThrow(StreamBusyError);
    expect(streams.get(stream.id).sessions.length).toBe(1);
  });

  test('a reviewer may run beside a live worker, but only one reviewer at a time', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const stream = await makeStream();
    await attachService.attach(stream.id);
    await waitFor(() => streams.get(stream.id).sessions.some((s) => s.status === 'running'));

    const review = await attachService.attach(stream.id, { role: 'reviewer' });
    expect(review.session.role).toBe('reviewer');
    await waitFor(
      () => streams.get(stream.id).sessions.filter((s) => s.status === 'running').length === 2,
    );

    await expect(attachService.attach(stream.id, { role: 'reviewer' })).rejects.toThrow(
      StreamBusyError,
    );
    // The worker slot is still taken too — one live session per role.
    await expect(attachService.attach(stream.id)).rejects.toThrow(StreamBusyError);
    expect(streams.get(stream.id).sessions.length).toBe(2);
  }, 30_000);
});

describe('D20: a coordinating node has no worktree', () => {
  test('a worker on a node with live children gets no branch or worktree; a work node does', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const root = await makeStream();
    const node = await streams.create('human', {
      title: 'ledger',
      goal: 'g',
      parent: root.id,
      repo: 'demo',
    });
    const child = await streams.create('human', { title: 'c', goal: 'g', parent: node.id });

    const coordinating = await attachService.attach(node.id);
    expect(coordinating.session.worktree).toBeUndefined();
    expect(streams.get(node.id).worktree).toBeUndefined();
    expect(streams.get(node.id).branch).toBeUndefined();
    await attachService.stopAll();

    // Once its only child is closed it is a work node again, and cuts one.
    await streams.close('human', child.id);
    const work = await attachService.attach(node.id);
    expect(work.session.worktree?.startsWith(join(repo, '.worktrees'))).toBe(true);
    await attachService.stopAll();
  }, 30_000);
});

describe('T176: Resolve — a worker handed the conflict, then the re-land', () => {
  test('attach.resolve appends the merge instruction to the brief; the resolved branch lands', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: [] } });
    const base = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const landing = new LandingService({ store, streams });
    const methods = buildAttachRpcMethods(attachService, verbs, landing);
    const stream = await makeStream('demo');
    const first = await attachService.attach(stream.id);
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    const wt = first.stream.worktree as string;
    writeFileSync(join(wt, 'shared.txt'), 'from the stream\n');
    git(['add', 'shared.txt'], wt);
    git(['commit', '-q', '-m', 'stream'], wt);
    writeFileSync(join(repo, 'shared.txt'), 'from the target\n');
    git(['add', 'shared.txt']);
    git(['commit', '-q', '-m', 'target']);
    expect((await landing.land(stream.id)).status).toBe('blocked');

    const resolved = (await methods['attach.resolve']?.({ stream: stream.id })) as {
      session: { id: string };
    };
    const briefPath = join(home, 'sessions', resolved.session.id, 'brief.md');
    await waitFor(() => existsSync(briefPath));
    const brief = readFileSync(briefPath, 'utf8');
    expect(brief).toContain('## Resolve the land conflict');
    expect(brief).toContain(`git merge ${base}`);
    expect(brief).toContain('shared.txt');
    await waitFor(() => streams.get(stream.id).agent.status === 'done');

    // What the worker would do: merge, keep both sides, commit.
    Bun.spawnSync(['git', 'merge', base], { cwd: wt });
    writeFileSync(join(wt, 'shared.txt'), 'from the target\nfrom the stream\n');
    git(['commit', '-q', '-am', 'merge target'], wt);
    expect((await landing.land(stream.id)).status).toBe('landed');
  }, 30_000);
});

describe('the reviewer (§4.2)', () => {
  test("runs on the worker's worktree under the reviewer role, and never cuts a branch of its own", async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const stream = await makeStream('demo');
    const { handle } = await attachService.attach(stream.id);
    handle.stop();
    await handle.exited;
    const worktree = streams.get(stream.id).worktree;
    expect(worktree).toBeDefined();
    const branch = streams.get(stream.id).branch;

    const { session } = await attachService.attach(stream.id, { role: 'reviewer' });
    expect(session.worktree).toBe(worktree ?? '');
    expect(streams.get(stream.id).branch).toBe(branch ?? '');

    // The registry entry is what the hook resolves a tool call's cwd
    // through — it must say `reviewer`, or the read-only table never runs.
    await waitFor(() => store.listAgents().some((a) => a.id === session.id));
    expect(store.listAgents().find((a) => a.id === session.id)?.record.role).toBe('reviewer');
  }, 30_000);

  test("the reviewer exit reports its findings and leaves a live worker's agent.status alone", async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const stream = await makeStream();
    await attachService.attach(stream.id);
    await waitFor(() => streams.get(stream.id).agent.status === 'working');

    const { session, handle } = await attachService.attach(stream.id, { role: 'reviewer' });
    await waitFor(() => store.listAgents().some((a) => a.id === session.id));
    await verbs.finding({
      session: session.id,
      severity: 'major',
      file: 'src/parse.ts',
      line: 12,
      text: 'the dialect sniffer ignores quoted separators',
    });

    handle.stop();
    await handle.exited;
    await waitFor(() => threadBodies(stream.id).some((b) => b.startsWith('review finished:')));

    const after = streams.get(stream.id);
    expect(threadBodies(stream.id).some((b) => b.startsWith('review finished: 1 finding '))).toBe(
      true,
    );
    // Both halves of §4.2: the thread narrative and the structured list.
    expect(
      streams
        .readThread(stream.id, { limit: 500 })
        .entries.some((e) => e.kind === 'finding' && e.by === `agent:${session.id}`),
    ).toBe(true);
    expect(after.agent.findings?.at(-1)).toMatchObject({
      severity: 'major',
      file: 'src/parse.ts',
      line: 12,
    });
    // The worker is still live: its field, its call.
    expect(after.agent.status).toBe('working');
    expect(after.sessions.find((s) => s.id === session.id)?.status).not.toBe('running');
  }, 30_000);

  test('T343: a reviewer is spawned with the read-only git env, a worker without it', async () => {
    const spawned: SpawnSessionOptions[] = [];
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS), (o) => {
      spawned.push(o);
      return spawnSession(o);
    });
    const stream = await makeStream();
    const worker = await attachService.attach(stream.id);
    worker.handle.stop();
    await worker.handle.exited;
    const reviewer = await attachService.attach(stream.id, { role: 'reviewer' });
    reviewer.handle.stop();
    await reviewer.handle.exited;

    const [workerEnv, reviewerEnv] = spawned.map((o) => o.envOverrides ?? {});
    expect(workerEnv?.GIT_ATTR_SOURCE).toBeUndefined();
    expect(workerEnv?.GIT_PAGER).toBeUndefined();
    expect(workerEnv?.GIT_CONFIG_COUNT).toBeUndefined();
    expect(reviewerEnv?.GIT_ATTR_SOURCE).toBe(EMPTY_TREE_SHA);
    expect(reviewerEnv?.GIT_PAGER).toBe('cat');
    const count = Number(reviewerEnv?.GIT_CONFIG_COUNT);
    const config = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        reviewerEnv?.[`GIT_CONFIG_KEY_${i}`],
        reviewerEnv?.[`GIT_CONFIG_VALUE_${i}`],
      ]),
    );
    expect(config).toMatchObject({
      'core.fsmonitor': 'false',
      'core.hooksPath': '/dev/null',
      'core.pager': 'cat',
    });
    // Everything else the worker got, the reviewer got too.
    expect(reviewerEnv?.GIT_EDITOR).toBe('true');
  }, 30_000);

  test('a reviewer never moves agent.status, even with no worker left', async () => {
    const stream = await makeStream();
    const { handle } = await attachService.attach(stream.id, { role: 'reviewer' });
    // No worker ever attached, so `agent.status` is still `idle` here.
    expect(streams.get(stream.id).agent.status).toBe('idle');
    // The review ends before anything is checked (CI saw it end at spawn).
    handle.stop();
    await handle.exited;
    await waitFor(() => threadBodies(stream.id).some((b) => b.startsWith('review finished:')));
    expect(threadBodies(stream.id).some((b) => b.startsWith('review finished: 0 findings'))).toBe(
      true,
    );
    // A review is not work: the worker's field is untouched.
    expect(streams.get(stream.id).agent.status).toBe('idle');
  }, 20_000);

  test('a reviewer whose turn ends on its own leaves agent.status alone', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS));
    const stream = await makeStream();
    const { handle } = await attachService.attach(stream.id, { role: 'reviewer' });
    await handle.exited;
    await waitFor(() => threadBodies(stream.id).some((b) => b.startsWith('review finished:')));
    expect(streams.get(stream.id).agent.status).toBe('idle');
  }, 20_000);

  test('auto_review starts a reviewer when the worker exits done', async () => {
    await store.putRepos({
      demo: { path: repo, protected_branches: ['main'], auto_review: true },
    });
    const stream = await makeStream('demo');
    const { session, handle } = await attachService.attach(stream.id);
    handle.stop();
    await handle.exited;

    await waitFor(() => streams.get(stream.id).sessions.length === 2);
    const reviewer = streams.get(stream.id).sessions.find((s) => s.id !== session.id);
    expect(reviewer?.role).toBe('reviewer');
    expect(reviewer?.worktree).toBe(streams.get(stream.id).worktree ?? '');
  }, 30_000);

  test('no auto_review means no second session', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const stream = await makeStream('demo');
    const { handle } = await attachService.attach(stream.id);
    handle.stop();
    await handle.exited;
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    await Bun.sleep(200);
    expect(streams.get(stream.id).sessions.length).toBe(1);
  }, 30_000);
});

describe('effort (D12)', () => {
  test('claude records the level and passes its own lever to the vendor', async () => {
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id, { effort: 'max' });
    expect(session.effort).toBe('max');
    expect(threadBodies(stream.id).some((b) => b.includes('ignored by'))).toBe(false);
  });

  test('a vendor with no effort mapping still starts, with a thread line saying so', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.gemini, SPEAKS));
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id, { vendor: 'gemini', effort: 'high' });

    expect(session.effort).toBeUndefined();
    expect(threadBodies(stream.id)).toContain('effort high ignored by gemini');
    await waitFor(() => threadBodies(stream.id).some((b) => b.includes('looking at the parser')));
  });
});

describe('one ACP message is one thread entry (T137)', () => {
  test('a usage_update between two chunks does not split the message', async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        steps: [
          { type: 'agent_text', text: 'Plan:\n' },
          // Bookkeeping arriving mid-message is exactly what split the
          // live run's message into two thread entries.
          { type: 'usage_update', used: 10, size: 1000 },
          { type: 'agent_text', text: '- read the parser' },
          { type: 'end_turn' },
        ],
      }),
    );
    const stream = await makeStream();
    await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).some((b) => b.includes('read the parser')));
    const lines = threadBodies(stream.id).filter((b) => b.includes('read the parser'));
    expect(lines).toEqual(['Plan:\n- read the parser']);
  }, 20_000);
});

describe('a failed thread append is logged and retried', () => {
  test('the first agent append throws: stderr.log says so and the line still lands', async () => {
    const original = streams.appendThread.bind(streams);
    let failed = 0;
    streams.appendThread = (async (...args: Parameters<typeof original>) => {
      if (args[0] === 'agent' && failed === 0) {
        failed += 1;
        throw new Error('disk hiccup');
      }
      return original(...args);
    }) as typeof streams.appendThread;
    try {
      attachService = buildAttachService(
        fakeProviderFor(ACP_PROVIDERS.claude, {
          steps: [{ type: 'agent_text', text: 'still here' }, { type: 'end_turn' }],
        }),
      );
      const stream = await makeStream();
      const { session } = await attachService.attach(stream.id);
      await waitFor(() => threadBodies(stream.id).includes('still here'));
      expect(failed).toBe(1);
      const stderr = readFileSync(join(home, 'sessions', session.id, 'stderr.log'), 'utf8');
      expect(stderr).toContain('thread append failed (retrying once): disk hiccup');
      expect(stderr).not.toContain('gave up');
    } finally {
      streams.appendThread = original;
    }
  }, 20_000);
});

describe('ask → answer → continue (T137)', () => {
  test('the answer is prompted into the waiting session, which continues and finishes', async () => {
    const sentinel = join(scratch, 'asked.flag');
    const log = join(scratch, 'prompts.jsonl');
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        logFile: log,
        turns: [
          [
            { type: 'agent_text', text: 'I need to know the delimiter' },
            { type: 'tool_call', toolCallId: 'ask-1', title: 'ask' },
            { type: 'wait_for_file', path: sentinel },
            { type: 'end_turn' },
          ],
          [{ type: 'agent_text', text: 'continuing with semicolon' }, { type: 'end_turn' }],
        ],
        steps: [{ type: 'end_turn' }],
      }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => store.listAgents().some((a) => a.id === session.id));

    // The verb the MCP bridge forwards, with the session id the bridge fixes.
    const { id } = await verbs.ask({ session: session.id, text: 'comma or semicolon?' });
    const open = questions.listOpen();
    expect(open.map((q: Question) => q.id)).toContain(id);
    expect(streams.get(stream.id).agent.status).toBe('question');
    expect(streams.get(stream.id).human.status).toBe('waiting_on_you');

    // Now the agent ends its turn, exactly as the live run did: the session
    // process is alive and idle, waiting for an answer.
    writeFileSync(sentinel, '');
    await waitFor(
      () => streams.get(stream.id).sessions.find((s) => s.id === session.id)?.status === 'idle',
    );
    // A turn that ended on an open question ends nothing: the session is
    // still live and the stream still says `question`.
    expect(streams.get(stream.id).agent.status).toBe('question');
    expect(store.listAgents().some((a) => a.id === session.id)).toBe(true);

    await questions.answer(id as Question['id'], { answer: 'semicolon', by: 'human' });

    // Delivery is a prompt, not a mailbox file: the live session gets a
    // second `session/prompt` carrying the answer.
    await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').includes('semicolon'));
    const prompts = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"session/prompt"'));
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain('semicolon');
    expect(prompts[1]).toContain('comma or semicolon?');
    // Nothing is written to a mailbox any more — the prompt *is* the delivery.
    expect(existsSync(join(home, 'bus', 'inbox', session.id))).toBe(false);

    // The second turn ends with no open question left: the worker is
    // finished, so the service stops the session and the exit path writes
    // `done`.
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(threadBodies(stream.id).some((b) => b.includes('continuing with semicolon'))).toBe(true);
    const after = streams.get(stream.id);
    expect(after.sessions.find((s) => s.id === session.id)?.status).toBe('stopped');
    expect(store.listAgents().some((a) => a.id === session.id)).toBe(false);
  }, 30_000);

  test('an answer with no live session stays on the thread and says so', async () => {
    const stream = await makeStream();
    const { session, handle } = await attachService.attach(stream.id);
    await waitFor(() => store.listAgents().some((a) => a.id === session.id));
    const { id } = await verbs.ask({ session: session.id, text: 'comma or semicolon?' });
    handle.stop();
    await handle.exited;

    await questions.answer(id as Question['id'], { answer: 'semicolon', by: 'human' });
    await waitFor(() =>
      threadBodies(stream.id).some((b) => b.startsWith('answer recorded with no live session')),
    );
    // T336: the exit path's `done` stays; `idle` would read as the human's stop.
    expect(streams.get(stream.id).agent.status).toBe('done');
  }, 30_000);
});

describe('the brief is written beside the session logs (T145)', () => {
  test('`<home>/sessions/<id>/brief.md` is what the agent was handed', async () => {
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    const path = join(home, 'sessions', session.id, 'brief.md');
    await waitFor(() => existsSync(path));
    const brief = readFileSync(path, 'utf8');
    // "What did the agent see" without the vendor's transcript: the rules
    // in scope, the goal, and anything else the assembler put in.
    expect(brief).toContain('## Rules in scope');
    expect(brief).toContain('decide the dialect and implement it');
  }, 20_000);
});

describe('a gate and a question in the same turn (T145)', () => {
  const POLICY: Policy = {
    gates: { land: 'human', rule_accept: 'human', classifier_review: 'human' },
    breaker_signals: [],
  };

  test('approving the gate closes the question too, and the turn ends the session', async () => {
    // Pete's `--help` run, exactly: the worker raised a plain `ask` and hit
    // the route-band gate in the same turn, the operator answered the gate,
    // the worker retried and ended its turn — and the question nobody ever
    // closed held the stream `working/open` for eleven minutes.
    const sentinel = join(scratch, 'decided.flag');
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        steps: [
          { type: 'agent_text', text: 'asking and trying an edit' },
          { type: 'tool_call', toolCallId: 'ask-1', title: 'ask' },
          { type: 'wait_for_file', path: sentinel },
          { type: 'end_turn' },
        ],
      }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => store.listAgents().some((a) => a.id === session.id));

    const { id: questionId } = await verbs.ask({
      session: session.id,
      text: 'comma or semicolon?',
    });
    const gate = await gates.request('classifier_review', {
      policy: POLICY,
      stream: stream.id,
      session: session.id,
      summary: 'editing a dependency manifest is never automatic',
      call: { tool: 'Edit', path: join(scratch, 'package.json'), fingerprint: '0123456789abcdef' },
    });
    expect(questions.listOpen().map((q: Question) => q.id)).toContain(questionId);

    // `agile answer HIL-… yes`, and then the retry the approval allows —
    // which is what spends the gate (`hook/route-band.ts` calls `consume`).
    await gates.respond(gate.id as HilId, 'approve', 'pete');
    await gates.consume(gate.id as HilId);

    // The question is closed by the decision, not left for nobody.
    const answered = questions.get(questionId as Question['id']);
    expect(answered.status).toBe('answered');
    expect(answered.resolved_as).toBe('superseded');
    expect(questions.listOpen()).toEqual([]);
    expect(
      threadBodies(stream.id).some((b) => b === `question ${questionId} superseded by ${gate.id}`),
    ).toBe(true);

    // The turn now ends with nothing open: the worker is finished, so the
    // session is stopped and the exit path writes `done`.
    writeFileSync(sentinel, '');
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    const after = streams.get(stream.id);
    expect(after.sessions.find((s) => s.id === session.id)?.status).toBe('stopped');
    expect(store.listAgents().some((a) => a.id === session.id)).toBe(false);
  }, 30_000);

  test('a turn that ends on a still-open question says `question`, never `working`', async () => {
    const sentinel = join(scratch, 'asked-only.flag');
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        steps: [
          { type: 'agent_text', text: 'asking' },
          { type: 'tool_call', toolCallId: 'ask-2', title: 'ask' },
          { type: 'wait_for_file', path: sentinel },
          { type: 'end_turn' },
        ],
      }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => store.listAgents().some((a) => a.id === session.id));
    const { id: questionId } = await verbs.ask({ session: session.id, text: 'which delimiter?' });

    // The stream is dragged back to `working` mid-turn (an answer delivery,
    // a status write from elsewhere): the turn-end rule must put it back.
    await streams.update('daemon', stream.id, {
      agent: { status: 'working' },
      human: { status: 'open' },
    });
    writeFileSync(sentinel, '');
    await waitFor(
      () => streams.get(stream.id).sessions.find((s) => s.id === session.id)?.status === 'idle',
    );
    expect(streams.get(stream.id).agent.status).toBe('question');
    expect(streams.get(stream.id).human.status).toBe('waiting_on_you');
    expect(questions.get(questionId as Question['id']).status).toBe('open');
  }, 30_000);
});

describe('say — the stream page composer (T161)', () => {
  test('with no worker the line is only a human thread line', async () => {
    const stream = await makeStream();
    const result = await attachService.say(stream.id, 'thinking about dialects');
    expect(result.prompted).toBeUndefined();
    expect(result.entry).toMatchObject({ by: 'human', kind: 'line' });
  });

  test('with a live worker the line is also prompted into it', async () => {
    const log = join(scratch, 'say-prompts.jsonl');
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS_THEN_HANGS, logFile: log }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).some((b) => b.includes('looking at the parser')));
    const result = await attachService.say(stream.id, 'use RFC 4180 quoting');
    expect(result.prompted).toBe(session.id);
    expect(
      streams
        .readThread(stream.id, { limit: 500 })
        .entries.some((e) => e.by === 'human' && e.body === 'use RFC 4180 quoting'),
    ).toBe(true);
    // Queued behind the hanging first turn: stopping ends both; the log
    // shows the brief was sent, and the say was accepted for delivery.
    expect(existsSync(log) && readFileSync(log, 'utf8').includes('"session/prompt"')).toBe(true);
  }, 30_000);

  test('the prompt tells the worker to reply on the stream first (T174)', () => {
    const text = sayPrompt('how many tests are you writing?');
    expect(text).toContain('The operator wrote on the stream: how many tests are you writing?');
    expect(text).toContain('Reply to the operator on the stream first, with `progress`');
    expect(text).toContain('answer it directly');
    expect(text).toContain('Then continue the work.');
    expect(text).not.toContain('Continue the work.\n');
  });

  test('a mid-turn line is queued, shown as queued, and still runs before the session is let go (T174)', async () => {
    const log = join(scratch, 'say-queued.jsonl');
    const sentinel = join(scratch, 'turn-one.flag');
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        logFile: log,
        steps: [{ type: 'agent_text', text: 'answered' }, { type: 'end_turn' }],
        turns: [
          [
            { type: 'agent_text', text: 'working on it' },
            { type: 'tool_call', toolCallId: 'read-9', title: 'read tests' },
            { type: 'wait_for_file', path: sentinel },
            { type: 'end_turn' },
          ],
        ],
      }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).some((b) => b.includes('working on it')));
    const result = await attachService.say(stream.id, 'how many tests are you writing?');
    expect(result.prompted).toBe(session.id);
    const sessionRef = () => streams.get(stream.id).sessions.find((s) => s.id === session.id);
    expect(sessionRef()?.queued).toEqual([result.entry.ts]);

    // The first turn ends with nothing open: before T174 the turn-end rule
    // stopped the session here and the queued line was never delivered.
    writeFileSync(sentinel, '');
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    const prompts = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.includes('"session/prompt"'));
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain(
      'The operator wrote on the stream: how many tests are you writing?',
    );
    expect(threadBodies(stream.id)).toContain('answered');
    expect(sessionRef()?.status).toBe('stopped');
    expect(sessionRef()?.queued).toBeUndefined();
  }, 30_000);

  test('a line to an idle-but-alive worker is prompted at once, never queued (T174)', async () => {
    const log = join(scratch, 'say-idle.jsonl');
    const sentinel = join(scratch, 'idle-ask.flag');
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        logFile: log,
        steps: [{ type: 'agent_text', text: 'noted' }, { type: 'end_turn' }],
        turns: [
          [
            { type: 'agent_text', text: 'asking' },
            { type: 'wait_for_file', path: sentinel },
            { type: 'end_turn' },
          ],
        ],
      }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => store.listAgents().some((a) => a.id === session.id));
    await verbs.ask({ session: session.id, text: 'which delimiter?' });
    writeFileSync(sentinel, '');
    const sessionRef = () => streams.get(stream.id).sessions.find((s) => s.id === session.id);
    await waitFor(() => sessionRef()?.status === 'idle');
    await attachService.say(stream.id, 'still there?');
    expect(sessionRef()?.queued).toBeUndefined();
    await waitFor(() => threadBodies(stream.id).includes('noted'));
    // Still waiting on the open question: idle again, not let go.
    await waitFor(() => sessionRef()?.status === 'idle');
  }, 30_000);

  test('a turn that ends while the queued marker is being written still runs the line (T174 review)', async () => {
    const log = join(scratch, 'say-race.jsonl');
    const sentinel = join(scratch, 'race-turn-one.flag');
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        logFile: log,
        steps: [{ type: 'agent_text', text: 'answered in race' }, { type: 'end_turn' }],
        turns: [
          [
            { type: 'agent_text', text: 'racing along' },
            { type: 'tool_call', toolCallId: 'read-r', title: 'read' },
            { type: 'wait_for_file', path: sentinel },
            { type: 'end_turn' },
          ],
        ],
      }),
    );
    const stream = await makeStream();
    await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).some((b) => b.includes('racing along')));
    // Hold say()'s marker write (the first stream update after the line) open.
    const original = store.updateStream.bind(store);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = false;
    store.updateStream = (async (...args: Parameters<typeof original>) => {
      if (armed) {
        armed = false;
        await held;
      }
      return original(...args);
    }) as typeof store.updateStream;
    try {
      const appended = streams.readThread(stream.id, { limit: 500 }).entries.length;
      armed = true;
      const saying = attachService.say(stream.id, 'raced question?');
      await waitFor(() => streams.readThread(stream.id, { limit: 500 }).entries.length > appended);
      // The running turn ends inside the window.
      writeFileSync(sentinel, '');
      await waitFor(
        () =>
          existsSync(log) &&
          readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l.includes('"session/prompt"')).length === 2,
      );
      release();
      await saying;
      await waitFor(() => streams.get(stream.id).agent.status === 'done');
      expect(readFileSync(log, 'utf8')).toContain('raced question?');
      expect(threadBodies(stream.id)).toContain('answered in race');
      expect(streams.get(stream.id).sessions.every((s) => s.queued === undefined)).toBe(true);
    } finally {
      release();
      store.updateStream = original;
    }
  }, 30_000);
});

describe('T204: creating a node starts its agent (P5)', () => {
  async function makeProject(session?: { model?: string; effort?: 'high' }) {
    const projects = new ProjectService(store, streams);
    const project = await projects.create({ name: 'Shop' });
    if (session !== undefined) await projects.update(project.id, { session });
    return project;
  }

  test('a work node gets a running worker in its worktree, with the project defaults', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'], effort: 'low' } });
    const project = await makeProject({ model: 'claude-sonnet-4-6', effort: 'high' });

    const node = await attachService.createNode('human', {
      title: 'CSV parser',
      goal: 'g',
      project: project.id,
      repo: 'demo',
    });

    expect(node.sessions).toHaveLength(1);
    const [session] = node.sessions;
    expect(session?.role).toBe('worker');
    // P5: flag → project → repo → home → built-in; the project beats the repo.
    expect(session?.vendor).toBe('claude');
    expect(session?.model).toBe('claude-sonnet-4-6');
    expect(session?.effort).toBe('high');
    expect(node.worktree?.startsWith(join(repo, '.worktrees'))).toBe(true);
    expect(attachService.handleFor(node.id)).toBeDefined();
  });

  test('a conversation node gets a session with no worktree', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const project = await makeProject();
    const node = await attachService.createNode('human', {
      title: 'Plan',
      goal: 'g',
      project: project.id,
    });
    expect(node.sessions).toHaveLength(1);
    expect(node.sessions[0]?.model).toBe('claude-opus-5-5');
    expect(node.worktree).toBeUndefined();
  });

  test('start: false makes the node and starts nothing', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const project = await makeProject();
    const node = await attachService.createNode('human', {
      title: 'Later',
      goal: 'g',
      project: project.id,
      repo: 'demo',
      start: false,
    });
    expect(node.sessions).toEqual([]);
    expect(node.worktree).toBeUndefined();
    expect(attachService.handleFor(node.id)).toBeUndefined();
  });

  test('a failed start still returns the node, with the reason on its thread', async () => {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    await store.updateProject(project.id, (p) => ({ ...p, session: { vendor: 'nope' } }));
    const node = await attachService.createNode('human', {
      title: 'Broken',
      goal: 'g',
      project: project.id,
    });
    expect(node.sessions).toEqual([]);
    expect(
      threadBodies(node.id).some((b) =>
        b.startsWith('could not start the agent: unknown vendor: nope'),
      ),
    ).toBe(true);
  });
});

describe('T330: a conversation node reads the registered repos (§4.4)', () => {
  let other: string;
  let secret: string;
  let shared: string;

  beforeEach(() => {
    other = mkdtempSync(join(tmpdir(), 'agile-attach-other-'));
    secret = mkdtempSync(join(tmpdir(), 'agile-attach-secret-'));
    shared = mkdtempSync(join(tmpdir(), 'agile-attach-shared-'));
    writeFileSync(join(other, 'README.md'), '# other\n');
  });

  afterEach(() => {
    for (const dir of [other, secret, shared]) rmSync(dir, { recursive: true, force: true });
  });

  async function shopWithRepos() {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    await store.putRepos({
      'ledger-lite': { path: other, protected_branches: ['main'] },
      secret: {
        path: secret,
        protected_branches: ['main'],
        visibility: { mode: 'private', projects: ['P-01ARZ3NDEKTSV4RRFFQ69G5FAV'] },
      },
      shared: {
        path: shared,
        protected_branches: ['main'],
        visibility: { mode: 'private', projects: [project.id] },
      },
    });
    return project;
  }

  test('the brief lists the repos it may read, with their paths, and + Repo', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const project = await shopWithRepos();
    const node = await attachService.createNode('human', {
      title: 'Plan',
      goal: 'plan work across ledger-lite',
      project: project.id,
    });
    const session = node.sessions[0];
    if (session === undefined) throw new Error('no session');
    const brief = readFileSync(join(home, 'sessions', session.id, 'brief.md'), 'utf8');
    expect(brief).toContain('## Repos you can read');
    expect(brief).toContain(`- ledger-lite: \`${other}\``);
    expect(brief).toContain(`- shared: \`${shared}\``);
    expect(brief).not.toContain(secret);
    expect(brief).toContain('+ Repo');
  });

  test('a work node is told the other repos it may read, beside its worktree', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const project = await shopWithRepos();
    await store.putRepos({
      ...store.getRepos(),
      'agile-test-repo': { path: repo, protected_branches: ['main'] },
    });
    const node = await attachService.createNode('human', {
      title: 'Entries',
      goal: 'use ledger-lite entries',
      project: project.id,
      repo: 'agile-test-repo',
    });
    const session = node.sessions[0];
    if (session === undefined) throw new Error('no session');
    expect(node.worktree).toBeDefined();
    const brief = readFileSync(join(home, 'sessions', session.id, 'brief.md'), 'utf8');
    expect(brief).toContain('## Repos you can read');
    expect(brief).toContain('Besides your own worktree');
    expect(brief).toContain(`- ledger-lite: \`${other}\``);
    expect(brief).toContain(`- shared: \`${shared}\``);
    expect(brief).not.toContain('- agile-test-repo:');
    expect(brief).not.toContain(secret);
    expect(brief).not.toContain('+ Repo');
  });

  test('a work node with no other readable repo gets no list', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const stream = await makeStream('demo');
    const { session } = await attachService.attach(stream.id);
    const brief = readFileSync(join(home, 'sessions', session.id, 'brief.md'), 'utf8');
    expect(brief).not.toContain('## Repos you can read');
  });

  test('ACP: reads reach a registered repo, never the agile home or an unlisted private repo', async () => {
    const results = ['public', 'home', 'secret', 'write'].map((n) => join(scratch, `${n}.json`));
    const permission = (
      id: string,
      kind: string,
      rawInput: Record<string, unknown>,
      resultFile: string,
    ) => ({
      type: 'request_permission' as const,
      toolCall: { toolCallId: id, kind, rawInput },
      options: [
        { optionId: 'allow', kind: 'allow_once' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
      resultFile,
    });
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        steps: [
          permission('r1', 'execute', { command: `cat ${other}/README.md` }, results[0] as string),
          permission('r2', 'read', { file_path: join(home, 'config.yaml') }, results[1] as string),
          permission('r3', 'execute', { command: `ls ${secret}` }, results[2] as string),
          permission('r4', 'edit', { file_path: join(other, 'README.md') }, results[3] as string),
          { type: 'hang' },
        ],
      }),
    );
    const project = await shopWithRepos();
    await attachService.createNode('human', { title: 'Plan', goal: 'g', project: project.id });
    await waitFor(() => results.every((path) => existsSync(path)));
    const chosen = results.map(
      (path) => JSON.parse(readFileSync(path, 'utf8')).outcome?.optionId as string | undefined,
    );
    // Writes stay confined to the session dir, as before.
    expect(chosen).toEqual(['allow', 'reject', 'reject', 'reject']);
  }, 30_000);
});

describe('T330: one long agent message is one thread entry', () => {
  /** A message streamed in `chunks` chunks of `sentence`, then a tool call, then a short message. */
  function longMessageScript(sentence: string, chunks: number): FakeAgentScript {
    return {
      steps: [
        { type: 'agent_text', text: 'Start: ' },
        ...Array.from({ length: chunks }, () => ({ type: 'agent_text' as const, text: sentence })),
        { type: 'agent_text', text: 'and it ends here' },
        { type: 'tool_call', toolCallId: 'read-1', title: 'read parser.ts' },
        { type: 'agent_text', text: 'next message' },
        { type: 'end_turn' },
      ],
    };
  }

  async function agentLinesOf(script: FakeAgentScript) {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, script));
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    // A session that ended first (a pipe Bun lost mid-turn, CI job
    // 108116863174) fails here at once, with the thread to read, rather
    // than after the whole waitFor budget.
    await waitFor(() =>
      threadBodies(stream.id).some((b) => b === 'next message' || b.startsWith('session ended')),
    );
    expect(threadBodies(stream.id)).toContain('next message');
    const lines = streams
      .readThread(stream.id, { limit: 500 })
      .entries.filter((e) => e.by.startsWith('agent:') && e.kind === 'line');
    const log = readFileSync(join(home, 'sessions', session.id, 'output.log'), 'utf8');
    return { lines, log, logPath: join(home, 'sessions', session.id, 'output.log') };
  }

  test('a 3,000-char message is one entry with all of its text', async () => {
    const sentence = 'All of this is one sentence that keeps going. '.repeat(10);
    const whole = `Start: ${sentence.repeat(7)}and it ends here`;
    expect(whole.length).toBeGreaterThan(3000);
    const { lines, log } = await agentLinesOf(longMessageScript(sentence, 7));
    expect(lines.map((e) => e.body)).toEqual([whole.trim(), 'next message']);
    expect(log).toContain(`${whole.trim()}\nnext message\n`);
  }, 30_000);

  test('a 20,000-char message is one entry, cut at the end with the output.log ref', async () => {
    const sentence = 'x'.repeat(1000);
    const { lines, log, logPath } = await agentLinesOf(longMessageScript(sentence, 20));
    expect(lines.map((e) => e.body.slice(0, 7))).toEqual(['Start: ', 'next me']);
    const [long] = lines;
    expect(long?.body.length).toBe(AGENT_LINE_MAX_CHARS);
    expect(long?.body.endsWith('…')).toBe(true);
    expect(long?.ref).toBe(logPath);
    expect(log).toContain(`Start: ${sentence.repeat(20)}and it ends here\nnext message\n`);
  }, 30_000);
});
