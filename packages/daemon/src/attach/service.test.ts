/**
 * `AttachService` against the real `fake-agent.ts` over a real ACP
 * transport — no vendor, no login, no network. Everything the acceptance
 * criteria name: a no-repo attach, a repo attach, the exit path, the
 * one-worker rule, the effort-ignored line, and `ask` reaching the inbox
 * and the answer reaching the session.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, type AcpProviderConfig } from '@agile-agents/acp-client';
import type { Question, Stream } from '@agile-agents/shared';
import { runInit } from '../init';
import { QuestionService } from '../questions/service';
import type { FakeAgentScript } from '../runner/fake-agent';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { AttachService, StreamBusyError } from './service';
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

/** Hangs after speaking, so a test can assert on a *live* session before stopping it. */
const SPEAKS_THEN_HANGS: FakeAgentScript = {
  steps: [
    { type: 'agent_text', text: 'looking at the parser now' },
    { type: 'end_turn' },
    { type: 'hang' },
  ],
};

function buildAttachService(provider: AcpProviderConfig): AttachService {
  return new AttachService({
    store,
    streams,
    home,
    provider: () => provider,
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
  questions = new QuestionService(store, streams);
  verbs = new VerbService({ store, streams, questions });
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
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('.worktrees/');

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

  test('a reviewer on a stream with no worker left moves agent.status to done', async () => {
    const stream = await makeStream();
    const { handle } = await attachService.attach(stream.id, { role: 'reviewer' });
    // No worker ever attached, so `agent.status` is still `idle` here.
    expect(streams.get(stream.id).agent.status).toBe('idle');
    handle.stop();
    await handle.exited;
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(threadBodies(stream.id).some((b) => b.startsWith('review finished: 0 findings'))).toBe(
      true,
    );
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

describe('ask routes to the inbox and the answer reaches the session', () => {
  test('a question raised by the live session, answered by the human', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => store.listAgents().some((a) => a.id === session.id));

    // The verb the MCP bridge forwards, with the session id the bridge
    // fixes — the stream is resolved from the registry, never from input.
    const { id } = await verbs.ask({ session: session.id, text: 'comma or semicolon?' });

    const open = questions.listOpen();
    expect(open.map((q: Question) => q.id)).toContain(id);
    expect(open[0]?.stream).toBe(stream.id);
    expect(streams.get(stream.id).agent.status).toBe('question');
    expect(streams.get(stream.id).human.status).toBe('waiting_on_you');

    await questions.answer(id as Question['id'], { answer: 'semicolon', by: 'human' });

    // Delivered into the waiting session's own mailbox, and the stream is
    // back at work because the session is still live.
    const inboxDir = join(home, 'bus', 'inbox', session.id);
    expect(readdirSync(inboxDir).length).toBe(1);
    expect(readFileSync(join(inboxDir, readdirSync(inboxDir)[0] ?? ''), 'utf8')).toContain(
      'semicolon',
    );
    expect(streams.get(stream.id).agent.status).toBe('working');
  });
});
