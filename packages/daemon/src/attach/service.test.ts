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
  realpathSync,
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
  type SessionRef,
  type Stream,
  type VendorFailureSettings,
  isRestingSession,
  ulid,
  validateClassifierConfig,
} from '@agile-agents/shared';
import { ClassifierUnavailableError, FakeClassifier } from '../classifier';
import { DeliveryService } from '../delivery/service';
import { KnowledgeWakeJudge } from '../events/knowledge-wake';
import { makeEmitter } from '../events/producers';
import { RoutedEventService } from '../events/service';
import { stoppedByHuman } from '../events/wake';
import { GateService } from '../gates/service';
import { CODEX_UNGATED_REASON, HookSightings } from '../hook/codex';
import { InboxService } from '../inbox/service';
import { runInit } from '../init';
import { KnowledgeService } from '../knowledge/service';
import { EMPTY_TREE_SHA } from '../permissions/git-env';
import { ProjectService } from '../projects/service';
import { ChatThreads } from '../questions/chat-threads';
import { QuestionService } from '../questions/service';
import { wireQuestionSupersession } from '../questions/supersede';
import { ChatThreadOps } from '../questions/thread-ops';
import type { FakeAgentScript } from '../runner/fake-agent';
import { ModelCatalog } from '../runner/model-catalog';
import { SESSION_STATE_FILE, USAGE_LOG_FILE, missingVendorCommand } from '../runner/session';
import { StateStore } from '../store';
import { AutoClose } from '../streams/auto-close';
import { RepoInPlaceService } from '../streams/repo-in-place';
import { StreamService } from '../streams/service';
import { buildAttachRpcMethods } from './rpc';
import { AgentWorkingError, lastAgentSession, resumableSession, sayPrompt } from './service';
import {
  AttachService,
  CRASHED_PREFIX,
  DAEMON_RESTART_IDLE_REASON,
  DAEMON_SHUTDOWN_REASON,
  FAILED_START_PREFIX,
  RESUMED_LINE,
  StreamBusyError,
  TURN_FINISHED_LINE,
  endedReason,
  idleEndReason,
} from './service';
import { VerbService } from './verbs';

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

let home: string;
let repo: string;
let scratch: string;
let codexHome: string;
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
 * ended with no open question would read `done` (T137; T465: its session
 * then rests, idle).
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
  extra: Partial<ConstructorParameters<typeof AttachService>[0]> = {},
): AttachService {
  return new AttachService({
    // T480: never the test machine's own `claude`/`codex` (a test passes one to check it).
    installedCli: () => undefined,
    // T506: a Codex home that trusts the temp dir, never the test machine's own.
    codexHome,
    ...extra,
    store,
    streams,
    home,
    provider: () => provider,
    questions: { listOpen: () => questions.listOpen() },
    gates: { list: () => gates.list() },
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
  codexHome = join(scratch, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, 'config.toml'),
    `[projects.${JSON.stringify(realpathSync(tmpdir()))}]\ntrust_level = "trusted"\n`,
  );
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

  test("T467a: the vendor's session/new reply is kept in the session dir, as sent", async () => {
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    const file = join(home, 'sessions', session.id, SESSION_STATE_FILE);
    await waitFor(() => existsSync(file));
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      at: string;
      configOptions: Array<{ id: string; currentValue: string }>;
      models: unknown;
    };
    expect(saved.at).toBeString();
    expect(saved.configOptions[0]).toMatchObject({ id: 'model' });
    expect(saved.models).toBeNull();
  });

  test('T467b: a reply with no modes, config options or models is kept too, naming what it carried', async () => {
    await attachService.stopAll();
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.cursor, { ...SPEAKS, bareSessionNew: true }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    const file = join(home, 'sessions', session.id, SESSION_STATE_FILE);
    await waitFor(() => existsSync(file));
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ modes: null, configOptions: null, models: null });
    expect(saved.keys).toEqual(['sessionId']);
  });

  test('T485a: what the vendor reports about token usage is kept raw in usage.jsonl', async () => {
    await attachService.stopAll();
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        steps: [
          { type: 'agent_text', text: 'done' },
          { type: 'usage_update', used: 1200, size: 200_000 },
          {
            type: 'end_turn',
            usage: { inputTokens: 900, outputTokens: 300, totalTokens: 1200 },
          },
        ],
      }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    const file = join(home, 'sessions', session.id, USAGE_LOG_FILE);
    await waitFor(
      () => existsSync(file) && readFileSync(file, 'utf8').includes('"kind":"turn_end"'),
    );
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.kind)).toEqual(['usage_update', 'turn_end']);
    expect(lines[0]).toMatchObject({
      update: { sessionUpdate: 'usage_update', used: 1200, size: 200_000 },
    });
    expect(lines[1]).toMatchObject({
      stopReason: 'end_turn',
      replyKeys: ['stopReason', 'usage'],
      usage: { inputTokens: 900, outputTokens: 300, totalTokens: 1200 },
    });
    expect(typeof lines[1]?.at).toBe('string');
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

describe('T288: a helper attaches off its parent', () => {
  test("the helper's worktree branches from the parent's branch", async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const parent = await makeStream('demo');
    git(['branch', 'host-branch']);
    const hostWt = join(repo, '.worktrees', 'host');
    git(['worktree', 'add', '-q', hostWt, 'host-branch']);
    writeFileSync(join(hostWt, 'host.txt'), 'host\n');
    git(['add', '-A'], hostWt);
    git(['commit', '-q', '-m', 'host work'], hostWt);
    await streams.update('daemon', parent.id, { branch: 'host-branch', worktree: hostWt });
    const helper = await streams.create('human', {
      title: 'helper',
      goal: 'help',
      parent: parent.id,
      helper_of: parent.id,
    });
    const { stream: updated } = await attachService.attach(helper.id);
    expect(existsSync(join(updated.worktree ?? '', 'host.txt'))).toBe(true);
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

    // A stop of the daemon's own with no reason (+ Repo's restart): SIGTERM,
    // escalating to SIGKILL after the client's own grace period. T432: ours, so no crash.
    await attachService.stop(stream.id, 'worker');
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

describe('T432 (D43): a vendor that exits with an error on its own', () => {
  test('is blocked, not done, and the thread says why in its own words', async () => {
    const complaint = 'Invalid API key · Please run /login';
    attachService = buildAttachService({
      ...ACP_PROVIDERS.claude,
      command: 'sh',
      args: ['-c', `echo "${complaint}" >&2; exit 1`],
    });
    const stream = await makeStream();
    const { session, handle } = await attachService.attach(stream.id);
    await handle.exited;
    await waitFor(() => streams.get(stream.id).agent.status === 'blocked');
    const after = streams.get(stream.id);
    expect(after.sessions.find((s) => s.id === session.id)?.status).toBe('error');
    expect(threadBodies(stream.id)).toContain(
      `session ended: process exited (code 1): ${complaint}`,
    );
  }, 20_000);

  test('a vendor that is not installed is named before anything spawns', async () => {
    attachService = buildAttachService({
      ...ACP_PROVIDERS.claude,
      command: 'definitely-not-a-vendor-xyz',
      args: [],
    });
    const stream = await makeStream();
    await expect(attachService.attach(stream.id)).rejects.toThrow(
      "Claude Code can't start: `definitely-not-a-vendor-xyz` is not on the daemon's PATH.",
    );
    // T437: nothing was recorded as starting; the node is stuck with the reason, never "Working".
    const after = streams.get(stream.id);
    expect(after.sessions).toEqual([]);
    expect(after.agent.status).toBe('blocked');
    expect(after.agent.progress).toBe(
      `${FAILED_START_PREFIX}Claude Code can't start: \`definitely-not-a-vendor-xyz\` is not on the daemon's PATH.`,
    );
  });

  test('T437: a spawn that throws after the session was recorded ends it as error, the node blocked', async () => {
    attachService = new AttachService({
      store,
      streams,
      home,
      provider: () => fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS),
      questions: { listOpen: () => questions.listOpen() },
      gates: { list: () => gates.list() },
      spawn: () => {
        throw new Error('the sandbox refused');
      },
    });
    const stream = await makeStream();
    await expect(attachService.attach(stream.id)).rejects.toThrow('the sandbox refused');
    const after = streams.get(stream.id);
    expect(after.sessions.map((s) => [s.status, s.ended_reason])).toEqual([
      ['error', 'the sandbox refused'],
    ]);
    expect(after.agent.status).toBe('blocked');
    expect(after.agent.progress).toBe(`${FAILED_START_PREFIX}the sandbox refused`);
  });

  test('T437: Stop ends a session recorded as live with no process behind it', async () => {
    const stream = await makeStream();
    const orphan = ulid();
    await store.updateStream('daemon', stream.id, (before) => ({
      ...before,
      agent: { ...before.agent, status: 'working' },
      sessions: [{ id: orphan, vendor: 'claude', model: 'm', role: 'worker', status: 'starting' }],
    }));
    expect(await attachService.stop(stream.id, undefined, { detach: true })).toEqual([orphan]);
    const after = streams.get(stream.id);
    expect(after.sessions[0]?.status).toBe('stopped');
    expect(after.agent.status).toBe('idle');
  });

  test('T444: at start, sessions a dead daemon left running end, and their nodes read idle', async () => {
    const stream = await makeStream();
    const other = await makeStream();
    const [a, b] = [ulid(), ulid()];
    await store.updateStream('daemon', stream.id, (before) => ({
      ...before,
      agent: { ...before.agent, status: 'working' },
      sessions: [
        { id: a, vendor: 'claude', model: 'm', role: 'worker', status: 'running' },
        { id: b, vendor: 'claude', model: 'm', role: 'reviewer', status: 'starting' },
      ],
    }));
    expect(await attachService.endOrphansAtStart()).toEqual([stream.id]);
    const after = streams.get(stream.id);
    expect(after.sessions.map((s) => [s.status, s.ended_reason])).toEqual([
      ['stopped', 'stopped: the daemon restarted during this turn'],
      ['stopped', 'stopped: the daemon restarted during this turn'],
    ]);
    expect(after.agent.status).toBe('idle');
    // Not the human's stop: its next event wakes it again.
    expect(stoppedByHuman(after)).toBe(false);
    expect(threadBodies(stream.id)).toContain(
      'session ended: the daemon restarted during this turn',
    );
    // A node with nothing on record is left alone.
    expect(streams.get(other.id).sessions).toEqual([]);
    expect(await attachService.endOrphansAtStart()).toEqual([]);
  });

  test('T437: a crash leaves its reason as the progress line; the next start clears it', async () => {
    attachService = buildAttachService({
      ...ACP_PROVIDERS.claude,
      command: 'sh',
      args: ['-c', 'echo "Invalid API key" >&2; exit 1'],
    });
    const stream = await makeStream();
    const { handle } = await attachService.attach(stream.id);
    await handle.exited;
    await waitFor(() => streams.get(stream.id).agent.status === 'blocked');
    expect(streams.get(stream.id).agent.progress).toBe(`${CRASHED_PREFIX}Invalid API key`);
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    await attachService.attach(stream.id);
    expect(streams.get(stream.id).agent.progress).toBeUndefined();
    await attachService.stopAll();
  }, 20_000);

  test('missingVendorCommand: npx names Node; a path or a found command is left alone', () => {
    const none = () => null;
    expect(missingVendorCommand({ label: 'Claude Code', command: 'npx' }, none)).toBe(
      "Claude Code can't start: `npx` is not on the daemon's PATH. It runs through npx: install Node.js, then restart the daemon.",
    );
    expect(
      missingVendorCommand({ label: 'Gemini CLI', command: '/opt/gemini' }, none),
    ).toBeUndefined();
    expect(missingVendorCommand({ label: 'X', command: 'x' }, () => '/usr/bin/x')).toBeUndefined();
  });

  test('missingVendorCommand: a command the bridge needs besides its own is named (T501)', () => {
    const pi = { label: 'Pi', command: 'npx', requiresCommands: ['pi'] };
    const only = (found: string[]) => (c: string) => (found.includes(c) ? `/usr/bin/${c}` : null);
    expect(missingVendorCommand(pi, only(['npx']))).toBe(
      "Pi can't start: `pi` is not on the daemon's PATH.",
    );
    // npx missing is named first, with its Node.js hint.
    expect(missingVendorCommand(pi, only([]))).toBe(
      "Pi can't start: `npx` is not on the daemon's PATH. It runs through npx: install Node.js, then restart the daemon.",
    );
    expect(missingVendorCommand(pi, only(['npx', 'pi']))).toBeUndefined();
    expect(missingVendorCommand(ACP_PROVIDERS.pi, only(['npx']))).toBe(
      "Pi can't start: `pi` is not on the daemon's PATH.",
    );
  });
});

describe('T456: a crashed agent is retried, then another vendor takes over', () => {
  const PANIC = 'panic: worker thread died';
  /** Crashes at every start, saying `line` on stderr. */
  const crashing = (vendor: AcpProviderConfig, line = PANIC): AcpProviderConfig => ({
    ...vendor,
    command: 'sh',
    args: ['-c', `echo "${line}" >&2; exit 1`],
    envOverrides: {},
  });
  /** Crashes at its first start only; after that it runs `script`. */
  const crashingOnce = (vendor: AcpProviderConfig, script: FakeAgentScript): AcpProviderConfig => {
    const marker = join(scratch, `crash-once-${ulid()}`);
    writeFileSync(marker, '');
    return {
      ...fakeProviderFor(vendor, script),
      command: 'sh',
      args: [
        '-c',
        `if [ -e "${marker}" ]; then rm "${marker}"; echo "${PANIC}" >&2; exit 1; fi; exec bun "${FAKE_AGENT_PATH}"`,
      ],
    };
  };
  const hangs = (vendor: AcpProviderConfig) => fakeProviderFor(vendor, SPEAKS_THEN_HANGS);
  let events: RoutedEventService;
  function build(
    byVendor: Record<string, AcpProviderConfig>,
    extra: Partial<ConstructorParameters<typeof AttachService>[0]> = {},
  ): AttachService {
    events = new RoutedEventService(store);
    return new AttachService({
      ...extra,
      store,
      streams,
      home,
      events,
      provider: (vendor, base) => byVendor[vendor] ?? base,
      questions: { listOpen: () => questions.listOpen() },
      gates: { list: () => gates.list() },
    });
  }
  const setFailure = (vendor_failure: VendorFailureSettings) =>
    store.setHomeSessionDefaults({ vendor_failure });
  const agents = (id: string) =>
    streams
      .get(id)
      .sessions.filter((s) => s.role === 'worker')
      .map((s) => [s.vendor, s.status]);
  const restarts = (id: string) =>
    events.activityFor(id).filter((a) => a.event.type === 'agent_restarted');
  const briefOf = (id: string, at: number) =>
    readFileSync(
      join(home, 'sessions', streams.get(id).sessions[at]?.id ?? '', 'brief.md'),
      'utf8',
    );

  test('a crash: the same vendor and model once more, in the same worktree; the node keeps working', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    attachService = build({ claude: crashingOnce(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS) });
    const stream = await makeStream('demo');
    const { session: first } = await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).includes('looking at the parser now'));

    const [a, b] = streams.get(stream.id).sessions;
    expect(a).toMatchObject({ id: first.id, vendor: 'claude', status: 'error' });
    expect(b).toMatchObject({
      vendor: 'claude',
      model: first.model,
      effort: first.effort,
      status: 'running',
      worktree: first.worktree,
    });
    expect(streams.get(stream.id).agent.status).toBe('working');
    expect(threadBodies(stream.id)).toContain(`Claude Code failed (${PANIC}); retrying once`);
    // Not D43's end: the chat shows no "stopped with an error" warning.
    expect(threadBodies(stream.id).some((line) => line.startsWith('session ended'))).toBe(false);
    const brief = briefOf(stream.id, 1);
    expect(brief).toContain(
      `The previous agent on this node (Claude Code) stopped mid-turn: ${PANIC}.`,
    );
    expect(brief).toContain('`git status`');
    // A record in Events and the node's Activity; it wakes nobody.
    const [restart] = restarts(stream.id);
    expect(restart?.status).toBe('recorded');
    expect(restart?.event.payload).toMatchObject({
      action: 'retry',
      from: 'claude',
      to: 'claude',
      reason: PANIC,
    });
  }, 30_000);

  test('the retry crashes too: the next vendor on the list takes over, with its own model', async () => {
    await setFailure({ fallback: ['gemini'], allow_hookless: true });
    attachService = build({
      claude: crashing(ACP_PROVIDERS.claude),
      gemini: hangs(ACP_PROVIDERS.gemini),
    });
    const stream = await makeStream();
    await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).includes('looking at the parser now'));

    expect(agents(stream.id)).toEqual([
      ['claude', 'error'],
      ['claude', 'error'],
      ['gemini', 'running'],
    ]);
    // D40: a model belongs to its vendor; Gemini gets its own default, not the Claude one.
    expect(streams.get(stream.id).sessions[2]?.model).toBe('default');
    expect(streams.get(stream.id).agent.status).toBe('working');
    const lines = threadBodies(stream.id);
    expect(lines).toContain(`Claude Code failed (${PANIC}); retrying once`);
    expect(lines).toContain(`Claude Code failed (${PANIC}); switched to Gemini CLI`);
    expect(briefOf(stream.id, 2)).toContain('You take its place.');
    expect(restarts(stream.id).map((r) => [r.event.payload.action, r.event.payload.to])).toEqual([
      ['switch', 'gemini'],
      ['retry', 'claude'],
    ]);
  }, 30_000);

  test('a login refusal is not retried: straight to the fallback', async () => {
    const refusal = 'Invalid API key · Please run /login';
    await setFailure({ fallback: ['gemini'], allow_hookless: true });
    attachService = build({
      claude: crashing(ACP_PROVIDERS.claude, refusal),
      gemini: hangs(ACP_PROVIDERS.gemini),
    });
    const stream = await makeStream();
    await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).includes('looking at the parser now'));
    expect(agents(stream.id)).toEqual([
      ['claude', 'error'],
      ['gemini', 'running'],
    ]);
    expect(threadBodies(stream.id)).toContain(
      `Claude Code failed (${refusal}); switched to Gemini CLI`,
    );
    expect(threadBodies(stream.id).some((line) => line.endsWith('retrying once'))).toBe(false);
  }, 30_000);

  // T460: Claude Code's expired login answers the prompt (its words, then a failed turn), its process alive.
  const LOGIN_EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  const refusesTurn = (vendor: AcpProviderConfig, said = LOGIN_EXPIRED) =>
    fakeProviderFor(vendor, {
      steps: [{ type: 'agent_text', text: said }, { type: 'reject_prompt' }],
    });

  test('T460: a turn refused for a login blocks in words, saying how to log in; no retry', async () => {
    attachService = build({ claude: refusesTurn(ACP_PROVIDERS.claude) });
    const stream = await makeStream();
    await attachService.attach(stream.id);
    await waitFor(() => streams.get(stream.id).agent.status === 'blocked');
    const how =
      'Claude Code isn’t logged in. Log in from a terminal (run `claude` and type /login), then send a message to start it again.';
    const after = streams.get(stream.id);
    expect(after.agent.progress).toBe(`The agent stopped with an error: ${how}`);
    expect(threadBodies(stream.id)).toContain(`session ended: turn failed: ${how}`);
    expect(after.sessions[0]?.ended_reason).toBe(`turn failed: ${how}`);
    // A login refusal isn't retried; no fallback is set, so nothing restarts.
    expect(agents(stream.id)).toEqual([['claude', 'error']]);
    expect(threadBodies(stream.id).some((line) => /retrying|switched/.test(line))).toBe(false);
  }, 30_000);

  test('T460: a turn refused for a login goes to the fallback vendor', async () => {
    await setFailure({ fallback: ['gemini'], allow_hookless: true });
    attachService = build({
      claude: refusesTurn(ACP_PROVIDERS.claude),
      gemini: hangs(ACP_PROVIDERS.gemini),
    });
    const stream = await makeStream();
    await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).includes('looking at the parser now'));
    expect(agents(stream.id)).toEqual([
      ['claude', 'error'],
      ['gemini', 'running'],
    ]);
    expect(streams.get(stream.id).agent.status).toBe('working');
    expect(threadBodies(stream.id)).toContain(
      `Claude Code failed (${LOGIN_EXPIRED}); switched to Gemini CLI`,
    );
  }, 30_000);

  test('T460: any other failed turn is retried once, then blocks naming what the agent said', async () => {
    const said = 'Something went wrong mid-turn';
    attachService = build({ claude: refusesTurn(ACP_PROVIDERS.claude, said) });
    const stream = await makeStream();
    await attachService.attach(stream.id);
    await waitFor(
      () =>
        streams.get(stream.id).agent.status === 'blocked' &&
        streams.get(stream.id).sessions.length === 2,
    );
    expect(agents(stream.id)).toEqual([
      ['claude', 'error'],
      ['claude', 'error'],
    ]);
    const lines = threadBodies(stream.id);
    expect(lines).toContain(`Claude Code failed (${said}); retrying once`);
    expect(lines).toContain(
      `session ended: turn failed: Claude Code’s turn failed: ${said}. Send a message to start it again.`,
    );
  }, 30_000);

  test('a fallback not installed is skipped, and one without hooks unless allowed', async () => {
    const byVendor = {
      claude: crashing(ACP_PROVIDERS.claude),
      cursor: { ...ACP_PROVIDERS.cursor, command: 'definitely-not-a-vendor-xyz' },
      gemini: hangs(ACP_PROVIDERS.gemini),
    };
    // Claude has hooks; Gemini doesn't, and Cursor isn't installed: nothing to switch to.
    await setFailure({ retry: false, fallback: ['cursor', 'gemini'] });
    attachService = build(byVendor);
    const held = await makeStream();
    await attachService.attach(held.id);
    await waitFor(() => streams.get(held.id).agent.status === 'blocked');
    expect(agents(held.id)).toEqual([['claude', 'error']]);
    expect(threadBodies(held.id)).toContain(`session ended: process exited (code 1): ${PANIC}`);

    await setFailure({ retry: false, fallback: ['cursor', 'gemini'], allow_hookless: true });
    const allowed = await makeStream();
    await attachService.attach(allowed.id);
    await waitFor(() => threadBodies(allowed.id).includes('looking at the parser now'));
    expect(agents(allowed.id)).toEqual([
      ['claude', 'error'],
      ['gemini', 'running'],
    ]);
  }, 30_000);

  test('the list spent: blocked as D43, the thread says why', async () => {
    await setFailure({ fallback: ['gemini'], allow_hookless: true });
    attachService = build({
      claude: crashing(ACP_PROVIDERS.claude),
      gemini: crashing(ACP_PROVIDERS.gemini, 'gemini exploded'),
    });
    const stream = await makeStream();
    await attachService.attach(stream.id);
    await waitFor(() => streams.get(stream.id).agent.status === 'blocked');
    expect(agents(stream.id)).toEqual([
      ['claude', 'error'],
      ['claude', 'error'],
      ['gemini', 'error'],
    ]);
    const lines = threadBodies(stream.id);
    expect(lines).toContain('Gemini CLI failed (gemini exploded); no other agent to switch to');
    expect(lines).toContain('session ended: process exited (code 1): gemini exploded');
    expect(streams.get(stream.id).agent.progress).toBe(`${CRASHED_PREFIX}gemini exploded`);
  }, 30_000);

  test('at most three restarts per node an hour', async () => {
    let now = 1_000_000;
    attachService = build({ claude: crashing(ACP_PROVIDERS.claude) }, { wakeClock: () => now });
    const stream = await makeStream();
    const blockedWith = (n: number) => () =>
      agents(stream.id).length === n && streams.get(stream.id).agent.status === 'blocked';
    // Each start crashes, is retried once, crashes again and blocks (D43).
    for (let i = 1; i <= 3; i++) {
      await attachService.attach(stream.id);
      await waitFor(blockedWith(2 * i));
    }
    const capped = `Claude Code failed (${PANIC}); not restarted: 3 restarts in the last hour`;
    await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).includes(capped));
    await waitFor(blockedWith(7));
    // An hour on, a crash is retried again.
    now += 3_600_000;
    await attachService.attach(stream.id);
    await waitFor(blockedWith(9));
  }, 60_000);

  test('a finished turn, a stop and a reviewer never trigger it', async () => {
    attachService = build({ claude: fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS) });
    const finished = await makeStream();
    await attachService.attach(finished.id);
    await waitFor(() => streams.get(finished.id).agent.status === 'done');
    expect(agents(finished.id)).toHaveLength(1);

    attachService = build({ claude: hangs(ACP_PROVIDERS.claude) });
    for (const options of [{ detach: true }, { reason: 'role changed to work' }]) {
      const stopped = await makeStream();
      await attachService.attach(stopped.id);
      await waitFor(() => threadBodies(stopped.id).includes('looking at the parser now'));
      await attachService.stop(stopped.id, 'worker', options);
      expect(streams.get(stopped.id).agent.status).toBe('idle');
      expect(agents(stopped.id)).toHaveLength(1);
    }

    attachService = build({ claude: crashing(ACP_PROVIDERS.claude) });
    const reviewed = await makeStream();
    await attachService.attach(reviewed.id, { role: 'reviewer' });
    await waitFor(() => threadBodies(reviewed.id).some((b) => b.startsWith('review finished')));
    expect(streams.get(reviewed.id).sessions.map((s) => [s.role, s.status])).toEqual([
      ['reviewer', 'error'],
    ]);
    expect(threadBodies(reviewed.id).some((b) => b.includes('retrying once'))).toBe(false);
  }, 60_000);

  test('the settings resolve project, then repo, then home', async () => {
    // Home: retry, no list. Repo: Gemini, hookless allowed. Project: no retry.
    await setFailure({ retry: true, fallback: [] });
    await store.putRepos({
      demo: {
        path: repo,
        protected_branches: ['main'],
        vendor_failure: { fallback: ['gemini'], allow_hookless: true },
      },
    });
    const projects = new ProjectService(store, streams);
    const project = await projects.create({ name: 'Shop', repos: ['demo'] });
    await projects.update(project.id, { vendor_failure: { retry: false } });
    // Claude would come back fine on a retry: its absence is the project's doing.
    attachService = build({
      claude: crashingOnce(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS),
      gemini: hangs(ACP_PROVIDERS.gemini),
    });
    const node = await attachService.createNode('human', {
      title: 'CSV parser',
      goal: 'g',
      project: project.id,
      repo: 'demo',
    });
    await waitFor(() => threadBodies(node.id).includes('looking at the parser now'));
    expect(agents(node.id)).toEqual([
      ['claude', 'error'],
      ['gemini', 'running'],
    ]);
    const [restart] = restarts(node.id);
    expect(restart?.event).toMatchObject({ project: project.id, repo: 'demo' });
  }, 30_000);
});

describe('T370: the daemon stopping mid-work', () => {
  test('leaves the node idle, not done, and wakeable', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).includes('looking at the parser now'));
    expect(streams.get(stream.id).agent.status).toBe('working');

    await attachService.stopAll();

    const after = streams.get(stream.id);
    expect(after.agent.status).toBe('idle');
    const ended = after.sessions.find((s) => s.id === session.id);
    expect(ended?.status).toBe('stopped');
    expect(ended?.ended_reason).toBe(`stopped: ${DAEMON_SHUTDOWN_REASON}`);
    expect(threadBodies(stream.id)).toContain(`worker stopped: ${DAEMON_SHUTDOWN_REASON}`);
    expect(threadBodies(stream.id).some((b) => b.startsWith('session ended:'))).toBe(false);
    // Not the human's stop: the node's next event wakes it.
    expect(stoppedByHuman(after)).toBe(false);
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
    // T371: the node by its title; the session id stays on the error, not in its words.
    await expect(attachService.attach(stream.id)).rejects.toThrow(
      `${stream.title} already has a live agent; stop it before starting another`,
    );
    expect(streams.get(stream.id).sessions.length).toBe(1);
  });

  test('T396: two starts at once (a wake and a click) give one agent', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const stream = await makeStream();
    const [first, second] = await Promise.allSettled([
      attachService.attach(stream.id),
      attachService.attach(stream.id),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(second.status === 'rejected' && second.reason).toBeInstanceOf(StreamBusyError);
    expect(streams.get(stream.id).sessions).toHaveLength(1);
    // A line sent with start while a start is in flight starts nothing more.
    const [started, said] = await Promise.all([
      attachService.attach(stream.id).catch(() => undefined),
      attachService.say(stream.id, 'hello', { start: true }),
    ]);
    expect(started).toBeUndefined();
    expect(said.started).toBeUndefined();
    expect(streams.get(stream.id).sessions).toHaveLength(1);
  }, 30_000);

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
    // A part (it has a repo): D42, a conversation child would leave it work.
    const child = await streams.create('human', {
      title: 'c',
      goal: 'g',
      parent: node.id,
      repo: 'demo',
    });

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
    const landing = new DeliveryService({ store, streams });
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
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS), {
      spawn: (o) => {
        spawned.push(o);
        return spawnSession(o);
      },
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
    // T345: no inherited CDPATH can redirect a checked `cd`.
    expect(workerEnv?.CDPATH).toBe('');
    expect(reviewerEnv?.CDPATH).toBe('');
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
    // T432: an end of the daemon's own (a crash starts no reviewer).
    await attachService.stop(stream.id, 'worker');
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
    // T432: the daemon's own stop (a vendor killed from outside is a crash, not a finish).
    await attachService.stop(stream.id, 'worker');
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
    // T505: Claude's commands are checked (its hook): no warning line.
    expect(threadBodies(stream.id).some((b) => b.includes('runs commands unchecked'))).toBe(false);
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

describe('T465 (D48): a finished turn keeps the session (T137, T341)', () => {
  test('the node reads done, the session stays alive and idle, and the thread says its turn finished', async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        steps: [{ type: 'agent_text', text: 'all done' }, { type: 'end_turn' }],
      }),
    );
    const stream = await makeStream();
    const { session, handle } = await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).includes(TURN_FINISHED_LINE));
    const after = streams.get(stream.id);
    expect(after.agent.status).toBe('done');
    const ref = after.sessions.find((s) => s.id === session.id);
    expect(ref?.status).toBe('idle');
    expect(isRestingSession(after, ref as SessionRef)).toBe(true);
    // The vendor's session id is on record for a later resume.
    expect(ref?.acp_session_id).toBe('fake-session-1');
    expect(threadBodies(stream.id).some((b) => b.startsWith('session ended:'))).toBe(false);
    expect(handle.stopped()).toBe(false);
    expect(store.listAgents().some((a) => a.id === session.id)).toBe(true);
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
      .slice(0, -1)
      .filter((line) => line.includes('"session/prompt"'));
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain('semicolon');
    expect(prompts[1]).toContain('comma or semicolon?');
    // Nothing is written to a mailbox any more — the prompt *is* the delivery.
    expect(existsSync(join(home, 'bus', 'inbox', session.id))).toBe(false);

    // The second turn ends with no open question left: the worker is
    // finished, so the node reads `done` and (T465) the session rests.
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(threadBodies(stream.id).some((b) => b.includes('continuing with semicolon'))).toBe(true);
    await waitFor(
      () => streams.get(stream.id).sessions.find((s) => s.id === session.id)?.status === 'idle',
    );
    expect(store.listAgents().some((a) => a.id === session.id)).toBe(true);
  }, 30_000);

  test('an answer with no live session stays on the thread and says so', async () => {
    const stream = await makeStream();
    const { session, handle } = await attachService.attach(stream.id);
    await waitFor(() => store.listAgents().some((a) => a.id === session.id));
    const { id } = await verbs.ask({ session: session.id, text: 'comma or semicolon?' });
    await attachService.stop(stream.id, 'worker');
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
    expect(brief).toContain('## Knowledge in scope');
    expect(brief).toContain('decide the dialect and implement it');
  }, 20_000);
});

describe('T420 (D42): a conversation under a node is told about it', () => {
  test('its brief frames the question and carries the parent’s state and newest lines', async () => {
    const parent = await makeStream();
    await streams.appendThread('human', parent.id, { kind: 'line', body: 'prefer semicolons' });
    const side = await streams.create('human', {
      title: 'Why this dialect?',
      goal: 'why did it pick this dialect?',
      parent: parent.id,
    });
    const { session } = await attachService.attach(side.id);
    const path = join(home, 'sessions', session.id, 'brief.md');
    await waitFor(() => existsSync(path));
    const brief = readFileSync(path, 'utf8');
    expect(brief).toContain('The human asked:\n\n> why did it pick this dialect?');
    expect(brief).toContain('## What you were asked about');
    expect(brief).toContain(`(\`${parent.id}\``);
    expect(brief).toContain('prefer semicolons');
  }, 20_000);
});

describe('T458: a conversation knows the work in progress', () => {
  test('its brief lists a sibling work node with its branch and worktree, not a hidden one', async () => {
    const secret = mkdtempSync(join(tmpdir(), 'agile-attach-secret-'));
    try {
      await store.putRepos({
        demo: { path: repo, protected_branches: ['main'] },
        secret: {
          path: secret,
          protected_branches: ['main'],
          visibility: { mode: 'private', projects: ['P-01ARZ3NDEKTSV4RRFFQ69G5FAV'] },
        },
      });
      const project = await new ProjectService(store, streams).create({
        name: 'Shop',
        repos: ['demo'],
      });
      const sibling = await streams.create('human', {
        title: 'Export CSV',
        goal: 'stream the export',
        project: project.id,
        parent: project.root,
        repo: 'demo',
      });
      const worktree = join(repo, '.worktrees', `${sibling.id}-export-csv`);
      await streams.update('daemon', sibling.id, {
        branch: `stream/${sibling.id}-export-csv`,
        worktree,
        agent: { status: 'working', progress: 'streaming rows to the writer' },
      });
      await streams.create('human', {
        title: 'Hidden work',
        goal: 'g',
        project: project.id,
        parent: project.root,
        repo: 'secret',
      });
      const side = await streams.create('human', {
        title: 'Anyone on export?',
        goal: 'is anyone touching the export code?',
        project: project.id,
        parent: project.root,
      });
      const { session } = await attachService.attach(side.id);
      const path = join(home, 'sessions', session.id, 'brief.md');
      await waitFor(() => existsSync(path));
      const brief = readFileSync(path, 'utf8');
      expect(brief).toContain('## Work in progress');
      expect(brief).toContain(
        `- **Export CSV** (\`${sibling.id}\`): repo demo, branch \`stream/${sibling.id}-export-csv\`, worktree \`${worktree}\`; agent working, human open; changed just now`,
      );
      expect(brief).toContain('  - Latest: streaming rows to the writer');
      // The node on a repo it can't read is left out, here and (T458b) from its parent's parts.
      expect(brief).toContain('Its parts:');
      expect(brief).not.toContain('Hidden work');
      expect(brief).not.toContain(secret);
    } finally {
      rmSync(secret, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("the brief carries the repo's own check commands (T339)", () => {
  async function briefFor(): Promise<string> {
    const stream = await makeStream('demo');
    const { session } = await attachService.attach(stream.id);
    const path = join(home, 'sessions', session.id, 'brief.md');
    await waitFor(() => existsSync(path));
    return readFileSync(path, 'utf8');
  }

  function commitPackageJson(): void {
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { lint: 'biome check .', test: 'bun test' } }),
    );
    writeFileSync(join(repo, 'bun.lock'), '{}');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'scripts']);
  }

  test("the worktree's package.json scripts, run with its lockfile's runner", async () => {
    commitPackageJson();
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const brief = await briefFor();
    expect(brief).toContain('## Checks');
    expect(brief).toContain('- `bun run test`\n- `bun run lint`');
  }, 20_000);

  test('a repo with `checks` set uses them instead', async () => {
    commitPackageJson();
    await store.putRepos({
      demo: { path: repo, protected_branches: ['main'], checks: ['make check'] },
    });
    const brief = await briefFor();
    expect(brief).toContain('- `make check`');
    expect(brief).not.toContain('bun run test');
  }, 20_000);
});

describe('a gate and a question in the same turn (T145)', () => {
  const POLICY: Policy = {
    gates: { land: 'human', rule_accept: 'human', classifier_review: 'human' },
    breaker_signals: [],
  };

  test('approving the gate closes the question too, and the turn finishes the work', async () => {
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
    // node reads `done` and (T465) the session rests for the next message.
    writeFileSync(sentinel, '');
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    await waitFor(
      () => streams.get(stream.id).sessions.find((s) => s.id === session.id)?.status === 'idle',
    );
    expect(store.listAgents().some((a) => a.id === session.id)).toBe(true);
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

describe('T464: a node keeps the model it ran on', () => {
  test('a changed default leaves a node that ran on its model; a new node takes the default; a pick sticks', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS));
    const ran = await makeStream();
    await attachService.attach(ran.id, { model: 'claude-sonnet-4-6', effort: 'high' });
    await waitFor(() => streams.get(ran.id).agent.status === 'done');
    const first = streams.get(ran.id).sessions[0];

    await store.setHomeSessionDefaults({
      vendor: 'claude',
      model: 'claude-opus-4-8',
      effort: 'low',
    });
    await attachService.attach(ran.id);
    await waitFor(() => streams.get(ran.id).agent.status === 'done');
    const second = streams.get(ran.id).sessions[1];
    expect({ model: second?.model, effort: second?.effort }).toEqual({
      model: first?.model,
      effort: 'high',
    });

    // T482: under the Default model choice, a node's first start takes the default.
    await store.setHomeModelPolicy({ mode: 'default' });
    const fresh = await makeStream();
    await attachService.attach(fresh.id);
    await waitFor(() => streams.get(fresh.id).agent.status === 'done');
    expect(streams.get(fresh.id).sessions[0]?.effort).toBe('low');

    // A pick (the chip, Start with…) is what runs, and what the node keeps from then on.
    await attachService.attach(ran.id, { model: 'claude-haiku-4-5', effort: 'medium' });
    await waitFor(
      () =>
        streams.get(ran.id).sessions.length === 3 && streams.get(ran.id).agent.status === 'done',
    );
    await attachService.attach(ran.id);
    await waitFor(
      () =>
        streams.get(ran.id).sessions.length === 4 && streams.get(ran.id).agent.status === 'done',
    );
    const [, , picked, after] = streams.get(ran.id).sessions;
    expect(after?.effort).toBe('medium');
    expect(after?.model).toBe(picked?.model);
  }, 30_000);

  test('lastAgentSession: the newest worker or coordinator, unless its vendor is gone', () => {
    const at = (role: string, vendor: string) => ({ role, vendor }) as never;
    const all = () => true;
    expect(lastAgentSession({ sessions: [] }, all)).toBeUndefined();
    expect(
      lastAgentSession({ sessions: [at('worker', 'claude'), at('reviewer', 'codex')] }, all),
    ).toMatchObject({ vendor: 'claude' });
    expect(
      lastAgentSession({ sessions: [at('worker', 'claude'), at('coordinator', 'gemini')] }, all),
    ).toMatchObject({ vendor: 'gemini' });
    expect(
      lastAgentSession({ sessions: [at('worker', 'gemini')] }, (v) => v !== 'gemini'),
    ).toBeUndefined();
  });
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
    expect(text).toContain(
      'Reply to the operator on the stream first by calling the `progress` tool',
    );
    expect(text).toContain('do not write the word "progress" into your message');
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
      .slice(0, -1)
      .filter((l) => l.includes('"session/prompt"'));
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain(
      'The operator wrote on the stream: how many tests are you writing?',
    );
    expect(threadBodies(stream.id)).toContain('answered');
    await waitFor(() => sessionRef()?.status === 'idle');
    expect(sessionRef()?.queued).toBeUndefined();
  }, 30_000);

  test('T461: a line starting with an advertised command is its own turn, sent as typed', async () => {
    const log = join(scratch, 'say-commands.jsonl');
    const sentinel = join(scratch, 'commands-turn-one.flag');
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        logFile: log,
        commands: [
          { name: 'compact', description: 'Clear the conversation but keep a summary' },
          { name: 'review', description: 'Review a pull request', input: { hint: 'PR number' } },
        ],
        steps: [{ type: 'agent_text', text: 'answered' }, { type: 'end_turn' }],
        turns: [
          [
            { type: 'agent_text', text: 'working on it' },
            { type: 'tool_call', toolCallId: 'read-1', title: 'read the parser' },
            { type: 'wait_for_file', path: sentinel },
            { type: 'end_turn' },
          ],
        ],
      }),
    );
    const stream = await makeStream();
    await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).some((b) => b.includes('working on it')));
    expect(attachService.commandsFor(stream.id)).toEqual({
      running: true,
      vendor: 'claude',
      commands: [
        { name: 'compact', description: 'Clear the conversation but keep a summary' },
        { name: 'review', description: 'Review a pull request', hint: 'PR number' },
      ],
    });
    const long = `use tabs ${'x'.repeat(1500)} end`;
    await attachService.say(stream.id, 'first, a note');
    await attachService.say(stream.id, '/compact keep the parser notes');
    await attachService.say(stream.id, long);
    await attachService.say(stream.id, '/unknown thing');

    writeFileSync(sentinel, '');
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    const sent = readFileSync(log, 'utf8')
      .split('\n')
      .slice(0, -1)
      .filter((l) => l.includes('"session/prompt"'))
      .map(
        (l) => (JSON.parse(l) as { params: { prompt: { text: string }[] } }).params.prompt[0]?.text,
      );
    // The brief, the note before the command, the command as typed, then the rest as a digest.
    expect(sent).toHaveLength(4);
    expect(sent[1]).toContain('The operator wrote on the stream: first, a note');
    expect(sent[1]).not.toContain('/compact');
    expect(sent[2]).toBe('/compact keep the parser notes');
    // A line past the event's 800-character cap reaches the agent whole.
    expect(sent[3]).toContain(long);
    // An unknown command is a message like any other.
    expect(sent[3]).toContain('The operator wrote on the stream: /unknown thing');
  }, 30_000);

  test('T461: with no agent running there are no commands', async () => {
    const stream = await makeStream();
    expect(attachService.commandsFor(stream.id)).toEqual({ running: false, commands: [] });
  });

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
            .slice(0, -1)
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

describe('T242: routed events reach the session as digests', () => {
  test('three lines during a turn produce one digest after it', async () => {
    const log = join(scratch, 'digest.jsonl');
    const sentinel = join(scratch, 'digest-turn-one.flag');
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        logFile: log,
        steps: [{ type: 'agent_text', text: 'read all three' }, { type: 'end_turn' }],
        turns: [
          [
            { type: 'agent_text', text: 'busy busy' },
            { type: 'tool_call', toolCallId: 'read-d', title: 'read' },
            { type: 'wait_for_file', path: sentinel },
            { type: 'end_turn' },
          ],
        ],
      }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).some((b) => b.includes('busy busy')));
    for (const body of ['first note', 'second note', 'third note']) {
      await attachService.say(stream.id, body);
    }
    const sessionRef = () => streams.get(stream.id).sessions.find((s) => s.id === session.id);
    expect(sessionRef()?.queued?.length).toBe(3);
    writeFileSync(sentinel, '');
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    const prompts = readFileSync(log, 'utf8')
      .split('\n')
      .slice(0, -1)
      .filter((l) => l.includes('"session/prompt"'));
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain('3 things arrived for you');
    for (const body of ['first note', 'second note', 'third note']) {
      expect(prompts[1]).toContain(body);
    }
    expect(sessionRef()?.queued).toBeUndefined();
    const delivered = store.readDeliveries(stream.id).filter((d) => d.status === 'delivered');
    expect(delivered.length).toBe(3);
    expect(delivered.every((d) => d.session === session.id)).toBe(true);
  }, 30_000);

  test('an answer with no live session waits for the next session', async () => {
    const log = join(scratch, 'answer-later.jsonl');
    const stream = await makeStream();
    const question = {
      id: 'Q-1',
      stream: stream.id,
      text: 'which delimiter?',
      answer: 'semicolons',
    } as unknown as Question;
    await attachService.deliverAnswer('S-gone', question);
    expect(store.readDeliveries(stream.id).map((d) => d.status)).toEqual(['pending']);
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log }),
    );
    await attachService.attach(stream.id);
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(readFileSync(log, 'utf8')).toContain('was answered: semicolons');
    expect(store.readDeliveries(stream.id).at(-1)?.status).toBe('delivered');
  }, 30_000);
});

describe('T204: creating a node starts its agent (P5)', () => {
  async function makeProject(session?: { model?: string; effort?: 'high' }) {
    const projects = new ProjectService(store, streams);
    // T482 (D54): these check the Default resolution (P5), not a routed Choose.
    const project = await projects.create({ name: 'Shop' }, 'human', {
      modelPolicy: { mode: 'default' },
    });
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

describe('T243: the wake policy (P11)', () => {
  /**
   * A conversation node whose first session ran and finished (`done`, no live worker).
   * T465: its session ends as soon as its turn finishes (an idle timeout of 0).
   */
  async function finishedNode(log: string, extra = {}): Promise<Stream> {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log }),
      { deliveryDelayMs: 5, sessionIdleMs: 0, ...extra },
    );
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await attachService.createNode('human', {
      title: 'Plan',
      goal: 'g',
      project: project.id,
    });
    await waitFor(() => streams.get(node.id).agent.status === 'done');
    await waitFor(() => attachService.handleFor(node.id) === undefined);
    return node;
  }
  const prompts = (log: string) =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '')
      .split('\n')
      .slice(0, -1)
      .filter((l) => l.includes('"session/prompt"'));

  test('a human line wakes a finished node, and the woken session gets it', async () => {
    const log = join(scratch, 'wake.jsonl');
    const node = await finishedNode(log);
    await attachService.say(node.id, 'one more thing');
    await waitFor(() => streams.get(node.id).sessions.length === 2);
    await waitFor(() => store.readDeliveries(node.id).at(-1)?.status === 'delivered');
    // `delivered` is written when the runner hands the digest to the turn,
    // just before it goes over ACP: the agent's log line follows it.
    await waitFor(() => prompts(log).some((p) => p.includes('one more thing')));
    expect(threadBodies(node.id)).toContain('woken by human line');
  }, 30_000);

  test('a stopped (detached) node is never woken; its events stay pending', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS), {
      deliveryDelayMs: 5,
    });
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await attachService.createNode('human', {
      title: 'Plan',
      goal: 'g',
      project: project.id,
    });
    await attachService.stop(node.id, 'worker', { detach: true });
    expect(streams.get(node.id).agent.status).toBe('idle');
    await attachService.say(node.id, 'are you there?');
    await Bun.sleep(200);
    expect(streams.get(node.id).sessions).toHaveLength(1);
    expect(store.readDeliveries(node.id).map((d) => d.status)).toEqual(['pending']);
  }, 30_000);

  test('past the wake budget the node goes to the inbox and its events stay pending', async () => {
    writeFileSync(join(home, 'config.yaml'), 'events:\n  wake_budget_per_hour: 1\n');
    const log = join(scratch, 'budget.jsonl');
    const node = await finishedNode(log);
    await attachService.say(node.id, 'first');
    await waitFor(() => streams.get(node.id).sessions.length === 2);
    await waitFor(
      () =>
        streams.get(node.id).agent.status === 'done' &&
        attachService.handleFor(node.id) === undefined &&
        store.readDeliveries(node.id).at(-1)?.status === 'delivered',
    );
    await attachService.say(node.id, 'second');
    await waitFor(() => streams.get(node.id).agent.status === 'blocked');
    expect(streams.get(node.id).human.status).toBe('waiting_on_you');
    expect(threadBodies(node.id).some((b) => b.startsWith('wake budget spent (1 wakes'))).toBe(
      true,
    );
    expect(streams.get(node.id).sessions).toHaveLength(2);
    expect(store.readDeliveries(node.id).at(-1)?.status).toBe('pending');
  }, 30_000);

  test('at daemon start, a node left with pending events is woken', async () => {
    const log = join(scratch, 'restart.jsonl');
    const node = await finishedNode(log);
    // Emitted by another service instance: this AttachService never hears it.
    await new RoutedEventService(store).emit({
      type: 'human_line',
      subject: node.id,
      payload: { body: 'left over' },
      by: 'human',
      routing: [{ node: node.id, because: 'self' }],
    });
    await Bun.sleep(50);
    expect(streams.get(node.id).sessions).toHaveLength(1);
    attachService.wakePending();
    await waitFor(() => store.readDeliveries(node.id).at(-1)?.status === 'delivered');
    // `delivered` is written when the runner hands the digest to the turn,
    // just before it goes over ACP: the agent's log line follows it.
    await waitFor(() => prompts(log).some((p) => p.includes('left over')));
  }, 30_000);

  /** Two registered repos with a `main` and one commit each, for + Repo. */
  async function twoRepos(): Promise<RepoInPlaceService> {
    const repos: Record<string, { path: string; protected_branches: string[] }> = {};
    for (const name of ['ledger-lite', 'agile-test-repo']) {
      const dir = join(scratch, name);
      mkdirSync(dir);
      git(['init', '-q', '-b', 'main'], dir);
      git(['config', 'user.email', 'test@example.com'], dir);
      git(['config', 'user.name', 'Test'], dir);
      writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
      git(['add', '-A'], dir);
      git(['commit', '-q', '-m', 'init'], dir);
      repos[name] = { path: dir, protected_branches: ['main'] };
    }
    await store.putRepos(repos);
    return new RepoInPlaceService(store, streams, {
      attach: (id) => attachService.attach(id),
      stop: (id, reason) =>
        attachService.stop(id, undefined, reason !== undefined ? { reason } : {}),
    });
  }
  /** No live session (T465: the coordinator's too, whose session ends after its turn) and every event's latest delivery record `delivered`. */
  const settled = (id: string) => {
    const latest = new Map(store.readDeliveries(id).map((d) => [d.event, d.status]));
    return (
      attachService.agentHandle(id) === undefined &&
      [...latest.values()].every((status) => status === 'delivered')
    );
  };

  test('T336: ended session, answer, + Repo twice, a human line: the coordinator runs and gets it', async () => {
    const log = join(scratch, 't336.jsonl');
    const node = await finishedNode(log);
    const reshape = await twoRepos();
    const asked = streams.get(node.id).sessions[0]?.id;
    const q = await questions.raise({
      stream: node.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      ...(asked !== undefined ? { session: asked } : {}),
      text: 'CSV or JSON?',
    });
    await questions.answer(q.id, { answer: 'CSV', by: 'human' });
    // No live session: the status the exit path left stays (not `idle`, the
    // human's stop), so the answer wakes the conversation (P11).
    expect(streams.get(node.id).agent.status).not.toBe('idle');
    await waitFor(() => prompts(log).some((p) => p.includes('CSV or JSON?')));
    await waitFor(() => streams.get(node.id).agent.status === 'done' && settled(node.id));

    await reshape.addRepo(node.id, 'ledger-lite');
    const { parts } = await reshape.addRepo(node.id, 'agile-test-repo');
    // T446 (audit r7 #18): a part is named for its node, then its repo.
    expect(parts.map((p) => p.title)).toEqual([
      `${node.title} · ledger-lite`,
      `${node.title} · agile-test-repo`,
    ]);
    // T336: the coordinator starts, though nothing was live; the parts wait for its plan.
    for (const part of parts) expect(attachService.handleFor(part.id)).toBeUndefined();
    expect(streams.get(parts[1]?.id as string).sessions).toHaveLength(0);
    expect(streams.get(node.id).sessions.map((s) => s.role)).toEqual(['coordinator']);
    await waitFor(() => streams.get(node.id).agent.status === 'done' && settled(node.id));

    await attachService.say(node.id, 'Go ahead. Write the plan and a contract');
    await waitFor(() => streams.get(node.id).sessions.length === 2);
    await waitFor(() => prompts(log).some((p) => p.includes('Go ahead. Write the plan')));
    expect(threadBodies(node.id)).toContain('woken by human line');
    // The coordinator runs in the session dir, not a worktree (D20).
    expect(streams.get(node.id).sessions.every((s) => s.worktree === undefined)).toBe(true);
  }, 60_000);

  test('T336: a detached node split into parts gets no coordinator and is not woken', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS), {
      deliveryDelayMs: 5,
    });
    const reshape = await twoRepos();
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await attachService.createNode('human', {
      title: 'Plan',
      goal: 'g',
      project: project.id,
    });
    await reshape.addRepo(node.id, 'ledger-lite');
    await attachService.stop(node.id, 'worker', { detach: true });
    await reshape.addRepo(node.id, 'agile-test-repo');
    expect(streams.get(node.id).sessions).toHaveLength(0);
    await attachService.say(node.id, 'are you there?');
    await Bun.sleep(200);
    expect(streams.get(node.id).sessions).toHaveLength(0);
    expect(store.readDeliveries(node.id).map((d) => d.status)).toEqual(['pending']);
  }, 60_000);

  test('T336: the woken session is told what woke it, by event id, and can read_event it', async () => {
    const log = join(scratch, 't336-told.jsonl');
    const node = await finishedNode(log);
    // The woken session stays live, so its session can call `read_event`.
    // T465: a vendor that can't load a session, so the woken one starts from the brief.
    await attachService.stopAll();
    attachService = buildAttachService(
      fakeProviderFor(
        { ...ACP_PROVIDERS.claude, loadSession: false },
        { ...SPEAKS_THEN_HANGS, logFile: log },
      ),
      { deliveryDelayMs: 5 },
    );
    await attachService.say(node.id, 'use the ledger CSV format');
    await waitFor(() => streams.get(node.id).sessions.length === 2);
    await waitFor(() => store.readDeliveries(node.id).at(-1)?.status === 'delivered');
    const event = store.readDeliveries(node.id).at(-1)?.event as string;
    const woken = streams.get(node.id).sessions.at(-1)?.id as string;
    expect(store.readDeliveries(node.id).at(-1)?.session).toBe(woken);
    await waitFor(() => prompts(log).length === 2);
    // The brief itself carries the event: its id, its type and the line, quoted as data.
    const brief = prompts(log)[1] ?? '';
    expect(brief).toContain('What woke you');
    expect(brief).toContain(`${event} (human_line)`);
    expect(brief).toContain('use the ledger CSV format');
    // ... and no digest repeats it.
    await Bun.sleep(100);
    expect(prompts(log)).toHaveLength(2);
    const reader = new VerbService({
      store,
      streams,
      questions,
      events: new RoutedEventService(store),
    });
    const read = reader.readEvent({ session: woken, id: event });
    expect(read.id).toBe(event);
    expect(read.summary).toContain('use the ledger CSV format');
  }, 30_000);
});

describe('T351, T453: accepting a decision wakes the conversation it came from (D36 D10, Q25)', () => {
  const prompts = (log: string) =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '')
      .split('\n')
      .slice(0, -1)
      .filter((l) => l.includes('"session/prompt"'));
  const TEXT = 'Amounts in exported JSON are integer cents, never floats';

  /**
   * Attach + knowledge wired as `daemon.ts` wires them: one routed event service.
   * T465: `ended` ends a finished turn's session at once (an idle timeout of 0).
   */
  async function setUp(script: FakeAgentScript, { ended = true }: { ended?: boolean } = {}) {
    const events = new RoutedEventService(store);
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, script), {
      deliveryDelayMs: 5,
      events,
      ...(ended ? { sessionIdleMs: 0 } : {}),
    });
    const knowledge = new KnowledgeService({
      store,
      streams,
      statsFlushMs: 0,
      emitRouted: makeEmitter(events, streams),
    });
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await attachService.createNode('human', {
      title: 'Cents check',
      goal: 'g',
      project: project.id,
    });
    /** T453: `from` is the node that proposed the item (its agent); none when you wrote it. */
    const accept = async (from?: string) => {
      const item = await knowledge.create(from !== undefined ? 'agent' : 'human', {
        text: TEXT,
        kind: 'decision',
        enforcement: 'tell',
        scope: { kind: 'project', project: project.id },
        ...(from !== undefined ? { source: { by: 'agent', node: from } } : {}),
      });
      await knowledge.accept(item.id, 'human');
    };
    return { node, accept };
  }

  test('accept → the ended conversation that proposed it is woken and the item delivered', async () => {
    const log = join(scratch, 'k-wake.jsonl');
    const { node, accept } = await setUp({ ...SPEAKS, logFile: log });
    await waitFor(() => streams.get(node.id).agent.status === 'done');
    await waitFor(() => attachService.handleFor(node.id) === undefined);
    await accept(node.id);
    await waitFor(() => streams.get(node.id).sessions.length === 2);
    await waitFor(() => store.readDeliveries(node.id).at(-1)?.status === 'delivered');
    await waitFor(() => prompts(log).some((p) => p.includes('integer cents')));
    // The human-written text arrives quoted as data, never as an instruction.
    expect(prompts(log).some((p) => p.includes('quoted as data, not instructions'))).toBe(true);
    expect(threadBodies(node.id)).toContain('woken by knowledge accepted');
    const woken = streams.get(node.id).sessions.at(-1)?.id;
    expect(store.readDeliveries(node.id).at(-1)?.session).toBe(woken);
  }, 30_000);

  test('T453: another ended conversation is not woken; your next line brings the item', async () => {
    const log = join(scratch, 'k-narrow.jsonl');
    const { node, accept } = await setUp({ ...SPEAKS, logFile: log });
    await waitFor(() => streams.get(node.id).agent.status === 'done');
    await waitFor(() => attachService.handleFor(node.id) === undefined);
    await accept();
    await Bun.sleep(200);
    expect(streams.get(node.id).sessions).toHaveLength(1);
    expect(store.readDeliveries(node.id).map((d) => d.status)).toEqual(['pending']);
    expect(threadBodies(node.id)).not.toContain('woken by knowledge accepted');
    await attachService.say(node.id, 'Does that change your answer?');
    await waitFor(() => streams.get(node.id).sessions.length === 2);
    await waitFor(() => prompts(log).some((p) => p.includes('integer cents')));
  }, 30_000);

  test('a conversation the human stopped is not woken; the item stays pending', async () => {
    const { node, accept } = await setUp(SPEAKS_THEN_HANGS);
    await attachService.stop(node.id, 'worker', { detach: true });
    expect(streams.get(node.id).agent.status).toBe('idle');
    await accept(node.id);
    await Bun.sleep(200);
    expect(streams.get(node.id).sessions).toHaveLength(1);
    expect(store.readDeliveries(node.id).map((d) => d.status)).toEqual(['pending']);
  }, 30_000);

  test('a live conversation gets the item once, in a digest, with no second session', async () => {
    const log = join(scratch, 'k-live.jsonl');
    const sentinel = join(scratch, 'k-live.flag');
    const { node, accept } = await setUp(
      {
        logFile: log,
        steps: [{ type: 'agent_text', text: 'noted' }, { type: 'end_turn' }],
        turns: [
          [
            { type: 'agent_text', text: 'reading ledger-lite' },
            { type: 'tool_call', toolCallId: 'read-k', title: 'read' },
            { type: 'wait_for_file', path: sentinel },
            { type: 'end_turn' },
          ],
        ],
      },
      { ended: false },
    );
    await waitFor(() => threadBodies(node.id).some((b) => b.includes('reading ledger-lite')));
    await accept();
    await Bun.sleep(100);
    expect(store.readDeliveries(node.id).map((d) => d.status)).toEqual(['pending']);
    writeFileSync(sentinel, '');
    await waitFor(() => streams.get(node.id).agent.status === 'done');
    await waitFor(() => streams.get(node.id).sessions[0]?.status === 'idle');
    await Bun.sleep(100);
    expect(streams.get(node.id).sessions).toHaveLength(1);
    const withItem = prompts(log).filter((p) => p.includes('integer cents'));
    expect(withItem).toHaveLength(1);
    const statuses = store.readDeliveries(node.id).map((d) => d.status);
    expect(statuses).toEqual(['pending', 'delivered']);
    expect(threadBodies(node.id)).not.toContain('woken by knowledge accepted');
  }, 30_000);
});

describe('T454: with knowledge_wake on, Jev decides which other conversations wake', () => {
  const prompts = (log: string) =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '')
      .split('\n')
      .slice(0, -1)
      .filter((l) => l.includes('"session/prompt"'));
  const TEXT = 'Amounts in exported JSON are integer cents, never floats';
  /** Jev's two values: "is the decision relevant?" and "is the conversation stale?". */
  const jevSays = (relevant: number, stale: number) =>
    new FakeClassifier((_state, qs) =>
      qs.map((q) => ({ id: q.id, probability: q.id === 'relevant' ? relevant : stale })),
    );

  async function setUp(
    script: FakeAgentScript,
    classifier: FakeClassifier,
    { settle = true }: { settle?: boolean } = {},
  ) {
    await store.setKnowledgeWake('jev');
    const events = new RoutedEventService(store);
    const logs: string[] = [];
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, script), {
      deliveryDelayMs: 5,
      events,
      // T465: a settled conversation's session ends as soon as its turn finishes.
      ...(settle ? { sessionIdleMs: 0 } : {}),
      knowledgeWake: new KnowledgeWakeJudge({
        store,
        streams: () => streams.list(),
        home,
        classifier,
        config: validateClassifierConfig({ api_key: 'fake-t454-key' }),
        log: (line) => logs.push(line),
      }),
    });
    const knowledge = new KnowledgeService({
      store,
      streams,
      statsFlushMs: 0,
      emitRouted: makeEmitter(events, streams),
    });
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await attachService.createNode('human', {
      title: 'Cents check',
      goal: 'How should exported amounts be stored?',
      project: project.id,
    });
    const accept = async (from?: string) => {
      const item = await knowledge.create(from !== undefined ? 'agent' : 'human', {
        text: TEXT,
        kind: 'decision',
        enforcement: 'tell',
        scope: { kind: 'project', project: project.id },
        ...(from !== undefined ? { source: { by: 'agent', node: from } } : {}),
      });
      await knowledge.accept(item.id, 'human');
    };
    if (settle) {
      // Its first turn ends and its session stops: a finished conversation.
      await waitFor(() => streams.get(node.id).agent.status === 'done');
      await waitFor(() => attachService.handleFor(node.id) === undefined);
    } else {
      await waitFor(() => threadBodies(node.id).some((b) => b.includes('looking at the parser')));
    }
    return { node, accept, logs };
  }

  test('relevant and current: the other conversation wakes once and gets the item', async () => {
    const log = join(scratch, 'jev-yes.jsonl');
    const jev = jevSays(0.95, 0.1);
    const { node, accept, logs } = await setUp({ ...SPEAKS, logFile: log }, jev);
    await accept();
    await waitFor(() => streams.get(node.id).sessions.length === 2);
    await waitFor(() => store.readDeliveries(node.id).at(-1)?.status === 'delivered');
    await waitFor(() => prompts(log).some((p) => p.includes('integer cents')));
    expect(threadBodies(node.id)).toContain(
      'woken by knowledge accepted (Jev judged the decision relevant)',
    );
    // Asked once, about both questions, with the item and the conversation in the state.
    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0]?.questions.map((q) => q.id)).toEqual(['relevant', 'stale']);
    expect(jev.calls[0]?.state).toContain(TEXT);
    expect(jev.calls[0]?.state).toContain('How should exported amounts be stored?');
    expect(jev.calls[0]?.state).toContain('looking at the parser now');
    expect(jev.calls[0]?.state).toContain('the project Shop');
    // The log names ids and values, never the conversation's text.
    expect(logs.some((l) => l.includes('waking'))).toBe(true);
    expect(logs.join('\n')).not.toContain('looking at the parser');
    await Bun.sleep(150);
    expect(streams.get(node.id).sessions).toHaveLength(2);
  }, 30_000);

  test('relevant but stale: not woken, the item stays pending for the next message', async () => {
    const log = join(scratch, 'jev-stale.jsonl');
    const jev = jevSays(0.95, 0.9);
    const { node, accept, logs } = await setUp({ ...SPEAKS, logFile: log }, jev);
    await accept();
    await waitFor(() => jev.calls.length === 1);
    await waitFor(() => logs.some((l) => l.includes('not woken')));
    await Bun.sleep(150);
    expect(streams.get(node.id).sessions).toHaveLength(1);
    expect(store.readDeliveries(node.id).map((d) => d.status)).toEqual(['pending']);
    // Your next line brings it, and Jev is not asked again.
    await attachService.say(node.id, 'Does that change your answer?');
    await waitFor(() => streams.get(node.id).sessions.length === 2);
    await waitFor(() => prompts(log).some((p) => p.includes('integer cents')));
    expect(jev.calls).toHaveLength(1);
  }, 30_000);

  test('the classifier unavailable: not woken', async () => {
    const jev = new FakeClassifier([], {
      throws: new ClassifierUnavailableError('timeout', 'classifier call timed out'),
    });
    const { node, accept, logs } = await setUp(SPEAKS, jev);
    await accept();
    await waitFor(() => logs.some((l) => l.includes('classifier unavailable (timeout)')));
    await Bun.sleep(150);
    expect(streams.get(node.id).sessions).toHaveLength(1);
    expect(store.readDeliveries(node.id).map((d) => d.status)).toEqual(['pending']);
  }, 30_000);

  test('the conversation that proposed it wakes without asking Jev', async () => {
    const jev = jevSays(0.05, 0.95);
    const { node, accept } = await setUp(SPEAKS, jev);
    await accept(node.id);
    await waitFor(() => streams.get(node.id).sessions.length === 2);
    expect(threadBodies(node.id)).toContain('woken by knowledge accepted');
    expect(jev.calls).toHaveLength(0);
  }, 30_000);

  test('a conversation the human stopped is never asked', async () => {
    const jev = jevSays(0.95, 0.05);
    const { node, accept } = await setUp(SPEAKS_THEN_HANGS, jev, { settle: false });
    await attachService.stop(node.id, 'worker', { detach: true });
    await accept();
    await Bun.sleep(200);
    expect(jev.calls).toHaveLength(0);
    expect(streams.get(node.id).sessions).toHaveLength(1);
    expect(store.readDeliveries(node.id).map((d) => d.status)).toEqual(['pending']);
  }, 30_000);
});

describe('T280: the coordinator role (P20)', () => {
  test('a coordinating node runs a coordinator; child_status wakes its resting session with a digest', async () => {
    const log = join(scratch, 'coordinator.jsonl');
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log }),
      { deliveryDelayMs: 5 },
    );
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    // D33: a child with a repo is what makes it coordinating.
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const node = await attachService.createNode('human', {
      title: 'Checkout',
      goal: 'g',
      project: project.id,
      start: false,
    });
    const child = await attachService.createNode('human', {
      title: 'Cart API',
      goal: 'g',
      project: project.id,
      parent: node.id,
      repo: 'demo',
      start: false,
    });

    const first = await attachService.attach(node.id);
    expect(first.session.role).toBe('coordinator');
    expect(first.session.worktree).toBeUndefined();
    const brief = readFileSync(join(home, 'sessions', first.session.id, 'brief.md'), 'utf8');
    expect(brief).toContain('# Coordinator brief');
    expect(brief).toContain('## Your children');
    expect(brief).toContain('Cart API');
    expect(brief).toContain('Autonomy: **advise**');
    await waitFor(() => streams.get(node.id).agent.status === 'done');
    // T465: its session rests after the turn.
    await waitFor(() => streams.get(node.id).sessions[0]?.status === 'idle');

    await new RoutedEventService(store).emit({
      type: 'child_status',
      subject: child.id,
      payload: { child: child.id, title: 'Cart API', status: 'blocked', progress: 'stuck on auth' },
      by: 'daemon',
      routing: [{ node: node.id, because: 'ancestor' }],
    });
    attachService.wakePending();
    await waitFor(() => store.readDeliveries(node.id).at(-1)?.status === 'delivered');
    // Into the same session: no second coordinator.
    expect(store.readDeliveries(node.id).at(-1)?.session).toBe(first.session.id);
    expect(streams.get(node.id).sessions.map((s) => s.role)).toEqual(['coordinator']);
    await waitFor(() =>
      (existsSync(log) ? readFileSync(log, 'utf8') : '')
        .split('\n')
        .slice(0, -1)
        .some((l) => l.includes('"session/prompt"') && l.includes('stuck on auth')),
    );
    expect(threadBodies(node.id)).toContain('woken by child status');
  }, 30_000);

  test('T332 (D33): a conversation with a tangent keeps its worker; no coordinator replaces it', async () => {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const talk = await attachService.createNode('human', {
      title: 'Why slow?',
      goal: 'g',
      project: project.id,
      start: false,
    });
    await streams.appendThread('human', talk.id, { kind: 'line', body: 'is it the cache?' });
    await attachService.createNode('human', {
      title: 'Cache?',
      goal: 'does the cache help?',
      parent: talk.id,
      seed_line: streams.readThread(talk.id).total - 1,
      start: false,
    });
    const first = await attachService.attach(talk.id);
    expect(first.session.role).toBe('worker');
    const brief = readFileSync(join(home, 'sessions', first.session.id, 'brief.md'), 'utf8');
    expect(brief).not.toContain('# Coordinator brief');
    await attachService.stopAll();
  }, 30_000);

  test('a parentless project root that has had a coordinator is woken by child_status', async () => {
    const log = join(scratch, 'root.jsonl');
    // T465: its session ends as soon as its turn finishes; the wake resumes it.
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log }),
      { deliveryDelayMs: 5, sessionIdleMs: 0 },
    );
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const root = await streams.create('human', { title: 'Shop', goal: 'g' });
    expect(root.parent).toBeUndefined();
    const child = await streams.create('human', {
      title: 'Cart',
      goal: 'g',
      parent: root.id,
      repo: 'demo',
    });
    const first = await attachService.attach(root.id);
    expect(first.session.role).toBe('coordinator');
    await waitFor(() => streams.get(root.id).agent.status === 'done');
    await waitFor(() => attachService.handleFor(root.id, 'coordinator') === undefined);

    await new RoutedEventService(store).emit({
      type: 'child_status',
      subject: child.id,
      payload: { child: child.id, title: 'Cart', status: 'done', progress: 'cart shipped' },
      by: 'daemon',
      routing: [{ node: root.id, because: 'ancestor' }],
    });
    attachService.wakePending();
    await waitFor(() => streams.get(root.id).sessions.length === 2);
    expect(streams.get(root.id).sessions.at(-1)?.role).toBe('coordinator');
    await waitFor(() =>
      (existsSync(log) ? readFileSync(log, 'utf8') : '')
        .split('\n')
        .slice(0, -1)
        .some((l) => l.includes('"session/prompt"') && l.includes('cart shipped')),
    );
    expect(threadBodies(root.id)).toContain('woken by child status');
  }, 30_000);

  test("T336: a work node woken by its coordinator's note is handed the note, quoted, with its id", async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const log = join(scratch, 't336-note.jsonl');
    const prompts = () =>
      (existsSync(log) ? readFileSync(log, 'utf8') : '')
        .split('\n')
        .slice(0, -1)
        .filter((l) => l.includes('"session/prompt"'));
    // T465: its session ends at once, and a vendor that can't load one starts from the brief.
    attachService = buildAttachService(
      fakeProviderFor({ ...ACP_PROVIDERS.claude, loadSession: false }, { ...SPEAKS, logFile: log }),
      { deliveryDelayMs: 5, sessionIdleMs: 0 },
    );
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const parent = await streams.create('human', {
      title: 'Ledger export',
      goal: 'g',
      project: project.id,
    });
    const node = await attachService.createNode('human', {
      title: 'ledger-lite part',
      goal: 'ledger-lite share of: g',
      project: project.id,
      parent: parent.id,
      repo: 'demo',
    });
    await waitFor(
      () =>
        streams.get(node.id).agent.status === 'done' &&
        attachService.handleFor(node.id) === undefined,
    );
    // The parent's `note_child`, emitted by another service instance.
    const note = await new RoutedEventService(store).emit({
      type: 'coordinator_note',
      subject: node.id,
      payload: { body: 'export CSV with a header row' },
      by: `agent:${parent.id}`,
      routing: [{ node: node.id, because: 'self' }],
    });
    attachService.wakePending();
    await waitFor(() => store.readDeliveries(node.id).at(-1)?.status === 'delivered');
    await waitFor(() => prompts().length === 2);
    const brief = prompts()[1] ?? '';
    expect(brief).toContain(`${note.id} (coordinator_note)`);
    expect(brief).toContain('Your coordinator says: \\"export CSV with a header row\\"');
    expect(threadBodies(node.id)).toContain('woken by coordinator note');
  }, 30_000);
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

  test("T457: the project's own repos lead the list, its Always dirs follow, and the posture is said", async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const project = await shopWithRepos();
    const projects = new ProjectService(store, streams);
    await projects.update(project.id, { repos: ['shared'], read_roots: [join(scratch, 'notes')] });
    const node = await attachService.createNode('human', {
      title: 'Plan',
      goal: 'plan work',
      project: project.id,
    });
    const session = node.sessions[0];
    if (session === undefined) throw new Error('no session');
    const brief = readFileSync(join(home, 'sessions', session.id, 'brief.md'), 'utf8');
    const own = brief.indexOf("Your project's repos:");
    expect(own).toBeGreaterThan(0);
    expect(brief.indexOf(`- shared: \`${shared}\``)).toBeGreaterThan(own);
    expect(brief.indexOf('Other repos you can read:')).toBeGreaterThan(
      brief.indexOf(`- shared: \`${shared}\``),
    );
    expect(brief.indexOf(`- ledger-lite: \`${other}\``)).toBeGreaterThan(
      brief.indexOf('Other repos you can read:'),
    );
    expect(brief).toContain(`- \`${join(scratch, 'notes')}\` (allowed for this project)`);
    expect(brief).toContain('Permissions: Ask.');
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

describe('a send to an agent already gone (CI job 108169280649)', () => {
  /**
   * Every session this spawns throws EPIPE from `cancel()`, as Bun's stdin
   * writer did when the daemon sent `session/cancel` to a dead agent. The
   * runner must still close and finish the session, and nothing may escape.
   */
  const cancelThrows: typeof spawnSession = (opts) => {
    const session = spawnSession(opts);
    session.cancel = () => {
      throw Object.assign(new Error('EPIPE: broken pipe, send'), { code: 'EPIPE' });
    };
    return session;
  };

  function buildWithSpawn(provider: AcpProviderConfig): AttachService {
    return new AttachService({
      store,
      streams,
      home,
      provider: () => provider,
      questions: { listOpen: () => questions.listOpen() },
      gates: { list: () => gates.list() },
      spawn: cancelThrows,
    });
  }

  test('an agent that dies mid-turn still ends the session, recorded as failed', async () => {
    attachService = buildWithSpawn(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        steps: [
          { type: 'agent_text', text: 'about to crash' },
          { type: 'tool_call', toolCallId: 'x-1', title: 'read' },
          { type: 'exit', code: 1 },
        ],
      }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).some((b) => b.startsWith('session ended')));
    const ended = streams.get(stream.id).sessions.find((s) => s.id === session.id);
    // T432 (D43): exit 1 mid-turn is a crash: the session failed and the node is stuck.
    expect(ended?.status).toBe('error');
    expect(streams.get(stream.id).agent.status).toBe('blocked');
    expect(threadBodies(stream.id)).toContain('about to crash');
  }, 30_000);

  test('stop() on a live session still closes it when the cancel send fails', async () => {
    attachService = buildWithSpawn(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).some((b) => b.includes('looking at the parser')));
    // Resolves (before the fix the throw escaped from `stop()`), and the
    // session is let go exactly as with a cancel that worked.
    expect(await attachService.stop(stream.id)).toEqual([session.id]);
    expect(streams.get(stream.id).sessions.find((s) => s.id === session.id)?.status).not.toBe(
      'running',
    );
    expect(await attachService.stop(stream.id)).toEqual([]);
  }, 30_000);
});

describe('T361: a live agent follows its node’s role', () => {
  /** Wired as `daemon.ts` wires it: every tree change asks the attach service. */
  beforeEach(async () => {
    streams = new StreamService(store, {
      onTreeChanged: (nodes) => attachService.followRoles(nodes),
    });
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
  });

  async function liveWorkNode(projectId: string): Promise<Stream> {
    const node = await attachService.createNode('human', {
      title: 'Checkout',
      goal: 'g',
      project: projectId,
      repo: 'demo',
      start: false,
    });
    await attachService.attach(node.id, { model: 'claude-sonnet-4-6', effort: 'high' });
    return streams.get(node.id);
  }

  const roles = (id: string) => streams.get(id).sessions.map((s) => [s.role, s.status]);

  test('a move that makes a work node coordinating restarts it as the coordinator, and back', async () => {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await liveWorkNode(project.id);
    const part = await attachService.createNode('human', {
      title: 'Cart API',
      goal: 'g',
      project: project.id,
      repo: 'demo',
      start: false,
    });

    await streams.move(part.id, node.id);
    let after = streams.get(node.id);
    expect(roles(node.id)).toEqual([
      ['worker', 'stopped'],
      ['coordinator', 'running'],
    ]);
    // A daemon stop: the node is not "stopped by the human", so it is still woken.
    expect(after.sessions[0]?.ended_reason).toBe('stopped: role changed to coordinating');
    expect(stoppedByHuman(after)).toBe(false);
    // The same model and effort, in the session dir (D20), not the worktree.
    expect(after.sessions[1]).toMatchObject({ model: 'claude-sonnet-4-6', effort: 'high' });
    expect(after.sessions[1]?.worktree).toBeUndefined();
    expect(attachService.handleFor(node.id, 'coordinator')).toBeDefined();
    expect(attachService.handleFor(node.id, 'worker')).toBeUndefined();
    expect(threadBodies(node.id)).toContain(
      'role changed to coordinating: restarted its agent as the coordinator',
    );
    // Nothing else starts: the part, and the project root (no agent live), stay as they were.
    expect(streams.get(part.id).sessions).toEqual([]);
    expect(streams.get(project.root).sessions).toEqual([]);

    await streams.move(part.id, project.id);
    after = streams.get(node.id);
    expect(roles(node.id).map(([role]) => role)).toEqual(['worker', 'coordinator', 'worker']);
    expect(after.sessions[1]?.ended_reason).toBe('stopped: role changed to work');
    expect(after.sessions[2]?.worktree).toBe(after.worktree);
    expect(threadBodies(node.id)).toContain(
      'role changed to work: restarted its agent as a worker',
    );
  }, 30_000);

  test('a child made under a live work node restarts it as the coordinator; closing it restarts the worker', async () => {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await liveWorkNode(project.id);
    const part = await attachService.createNode('human', {
      title: 'Cart API',
      goal: 'g',
      parent: node.id,
      repo: 'demo',
      start: false,
    });
    expect(roles(node.id)).toEqual([
      ['worker', 'stopped'],
      ['coordinator', 'running'],
    ]);
    await streams.close('human', part.id);
    expect(roles(node.id).map(([role]) => role)).toEqual(['worker', 'coordinator', 'worker']);
    expect(attachService.handleFor(node.id, 'worker')).toBeDefined();
  }, 30_000);

  test('a bare project root running a worker gets its coordinator when it gains a part', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const root = await streams.create('human', { title: 'Shop', goal: 'g' });
    await attachService.attach(root.id);
    expect(roles(root.id)).toEqual([['worker', 'running']]);
    // D42: a question asked under it is not a part: the root keeps its worker.
    await streams.create('human', { title: 'Why?', goal: 'g', parent: root.id });
    expect(roles(root.id)).toEqual([['worker', 'running']]);
    await streams.create('human', { title: 'Cart', goal: 'g', parent: root.id, repo: 'demo' });
    expect(roles(root.id).map(([role]) => role)).toEqual(['worker', 'coordinator']);
    expect(threadBodies(root.id)).toContain(
      'the project root now has parts: restarted its agent as the coordinator',
    );
  }, 30_000);

  test('D42: a question asked under a working work node leaves its worker alone', async () => {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const work = await liveWorkNode(project.id);
    expect(roles(work.id)).toEqual([['worker', 'running']]);
    await attachService.createNode('human', {
      title: 'What is it doing?',
      goal: 'what is the parent working on right now?',
      parent: work.id,
      start: false,
    });
    expect(roles(work.id)).toEqual([['worker', 'running']]);
    expect(attachService.handleFor(work.id, 'coordinator')).toBeUndefined();
  }, 30_000);

  test('a node the human stopped, or never started, is left alone', async () => {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const stopped = await liveWorkNode(project.id);
    await attachService.stop(stopped.id, 'worker', { detach: true });
    const later = await attachService.createNode('human', {
      title: 'Later',
      goal: 'g',
      project: project.id,
      repo: 'demo',
      start: false,
    });
    for (const parent of [stopped.id, later.id]) {
      await attachService.createNode('human', {
        title: 'part',
        goal: 'g',
        parent,
        repo: 'demo',
        start: false,
      });
    }
    expect(roles(stopped.id)).toEqual([['worker', 'stopped']]);
    expect(streams.get(later.id).sessions).toEqual([]);
    expect(attachService.handleFor(stopped.id, 'coordinator')).toBeUndefined();
  }, 30_000);
});

describe('T361: a message starts a node with no live agent', () => {
  const prompts = (log: string) =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '')
      .split('\n')
      .slice(0, -1)
      .filter((l) => l.includes('"session/prompt"'));

  test('a never-started node starts, and the line is in its first prompt, once', async () => {
    const log = join(scratch, 'start.jsonl');
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS_THEN_HANGS, logFile: log }),
      { deliveryDelayMs: 5 },
    );
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await attachService.createNode('human', {
      title: 'Plan',
      goal: 'g',
      project: project.id,
      start: false,
    });

    const said = await attachService.say(node.id, 'start with the parser', { start: true });

    const sessions = streams.get(node.id).sessions;
    expect(sessions.map((s) => s.role)).toEqual(['worker']);
    expect(said.started).toBe(true);
    expect(said.prompted).toBe(sessions[0]?.id);
    expect(said.entry).toMatchObject({ by: 'human', kind: 'line', body: 'start with the parser' });
    await waitFor(() => store.readDeliveries(node.id).at(-1)?.status === 'delivered');
    await waitFor(() => prompts(log).length > 0);
    await Bun.sleep(100);
    // Handed over in the brief: no digest repeats it.
    expect(prompts(log)).toHaveLength(1);
    expect(prompts(log)[0]).toContain('The operator wrote on the stream: start with the parser');
    expect(store.readDeliveries(node.id).map((d) => d.status)).toEqual(['pending', 'delivered']);
    expect(store.readDeliveries(node.id).at(-1)?.session).toBe(said.prompted);
  }, 30_000);

  test('a node the human stopped stays stopped without start, and starts with it', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS), {
      deliveryDelayMs: 5,
    });
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await attachService.createNode('human', {
      title: 'Plan',
      goal: 'g',
      project: project.id,
    });
    await attachService.stop(node.id, 'worker', { detach: true });

    const plain = await attachService.say(node.id, 'are you there?');
    await Bun.sleep(100);
    expect(plain.started).toBeUndefined();
    expect(plain.prompted).toBeUndefined();
    expect(streams.get(node.id).sessions).toHaveLength(1);

    const said = await attachService.say(node.id, 'carry on', { start: true });
    expect(said.started).toBe(true);
    expect(streams.get(node.id).sessions.at(-1)?.id).toBe(said.prompted);
    // Both lines were pending; both went in with the brief.
    const delivered = () => store.readDeliveries(node.id).filter((d) => d.status === 'delivered');
    await waitFor(() => delivered().length === 2);
    expect(delivered().every((d) => d.session === said.prompted)).toBe(true);
  }, 30_000);

  test('T423: a starting line runs the model it names; the defaults fill the rest', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await attachService.createNode('human', {
      title: 'Plan',
      goal: 'g',
      project: project.id,
      start: false,
    });
    const said = await attachService.say(node.id, 'go', {
      start: true,
      session: { model: 'claude-sonnet-4-6', effort: 'high' },
    });
    expect(said.started).toBe(true);
    expect(streams.get(node.id).sessions).toMatchObject([
      { role: 'worker', vendor: 'claude', model: 'claude-sonnet-4-6', effort: 'high' },
    ]);
    // A live agent keeps its model: the flags only ever name a start.
    const again = await attachService.say(node.id, 'and now', {
      start: true,
      session: { model: 'claude-haiku-4-5' },
    });
    expect(again.started).toBeUndefined();
    expect(again.prompted).toBe(said.prompted);
    expect(streams.get(node.id).sessions).toHaveLength(1);
  }, 30_000);

  test('a live agent is prompted as before; start changes nothing', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    const said = await attachService.say(stream.id, 'hello', { start: true });
    expect(said.prompted).toBe(session.id);
    expect(said.started).toBeUndefined();
    expect(streams.get(stream.id).sessions).toHaveLength(1);
  }, 30_000);

  test('a coordinating node gets its coordinator; a merged node starts nothing, a closed one reopens (T471); a bare project root its coordinator', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await attachService.createNode('human', {
      title: 'Checkout',
      goal: 'g',
      project: project.id,
      start: false,
    });
    const part = await attachService.createNode('human', {
      title: 'Cart API',
      goal: 'g',
      parent: node.id,
      repo: 'demo',
      start: false,
    });
    const coordinated = await attachService.say(node.id, 'plan it', { start: true });
    expect(coordinated.started).toBe(true);
    expect(streams.get(node.id).sessions.map((s) => s.role)).toEqual(['coordinator']);
    expect(streams.get(part.id).sessions).toEqual([]);

    const closed = await attachService.createNode('human', {
      title: 'Old',
      goal: 'g',
      project: project.id,
      start: false,
    });
    await streams.update('daemon', closed.id, { human: { status: 'landed' } });
    const said = await attachService.say(closed.id, 'hello?', { start: true });
    expect(said.started).toBeUndefined();
    expect(said.prompted).toBeUndefined();
    expect(streams.get(closed.id).sessions).toEqual([]);
    // T471: closed is inactive, not read-only: a message reopens it and wakes its agent.
    const shut = await attachService.createNode('human', {
      title: 'Paused',
      goal: 'g',
      project: project.id,
      start: false,
    });
    await streams.close('human', shut.id);
    const woke = await attachService.say(shut.id, 'pick this up again', { start: true });
    expect(woke.started).toBe(true);
    expect(streams.get(shut.id).human.status).toBe('open');
    expect(streams.readThread(shut.id).entries.map((e) => e.body)).toContain('reopened');
    expect(streams.get(shut.id).sessions.map((s) => s.role)).toEqual(['worker']);
    // T443 (audit r7 #4): a bare project root coordinates from the start, so "plan this and split
    // it" reaches a coordinator that can add parts.
    const bare = await new ProjectService(store, streams).create({ name: 'Blog' });
    const planned = await attachService.say(bare.root, 'Plan the blog and split it.', {
      start: true,
    });
    expect(planned.started).toBe(true);
    expect(streams.get(bare.root).sessions.map((s) => s.role)).toEqual(['coordinator']);
  }, 30_000);

  test('T389: a part waiting for its plan is not started by a line; the line waits for it', async () => {
    let waiting = '';
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS), {
      plans: {
        get: () => undefined,
        childView: () => undefined,
        waitingForPlan: (s) => s.id === waiting,
      },
    });
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await attachService.createNode('human', {
      title: 'Cart API',
      goal: 'g',
      project: project.id,
      start: false,
    });
    waiting = node.id;
    const said = await attachService.say(node.id, 'use the new schema', { start: true });
    expect(said.started).toBeUndefined();
    expect(said.prompted).toBeUndefined();
    expect(streams.get(node.id).sessions).toEqual([]);
    expect(store.readDeliveries(node.id).map((d) => d.status)).toEqual(['pending']);
  }, 30_000);

  test('a failed start is a thread line; the line stays pending', async () => {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    await store.updateProject(project.id, (p) => ({ ...p, session: { vendor: 'nope' } }));
    const node = await attachService.createNode('human', {
      title: 'Broken',
      goal: 'g',
      project: project.id,
      start: false,
    });
    const said = await attachService.say(node.id, 'go', { start: true });
    expect(said.started).toBeUndefined();
    expect(threadBodies(node.id).at(-1)).toStartWith(
      'could not start the agent: unknown vendor: nope',
    );
    expect(store.readDeliveries(node.id).map((d) => d.status)).toEqual(['pending']);
  });
});

describe('T465 (D48): a finished turn keeps its session; an ended one resumes', () => {
  const log = () => join(scratch, 't465.jsonl');
  const logLines = () =>
    (existsSync(log()) ? readFileSync(log(), 'utf8') : '')
      .split('\n')
      .slice(0, -1)
      .filter((l) => l.trim() !== '');
  const prompts = () => logLines().filter((l) => l.includes('"session/prompt"'));
  const loads = () => logLines().filter((l) => l.includes('"session/load"'));
  const statusOf = (id: string, session: string) =>
    streams.get(id).sessions.find((s) => s.id === session)?.status;
  /** A node in a project, so a line starts its agent (T361; a bare parentless stream waits, T443). */
  const lineStarts = async (): Promise<Stream> => {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    return attachService.createNode('human', {
      title: 'CSV parser',
      goal: 'decide the dialect and implement it',
      project: project.id,
      start: false,
    });
  };

  test('the next message goes into the same session: one session, two prompts', async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log() }),
      { deliveryDelayMs: 5 },
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => statusOf(stream.id, session.id) === 'idle');
    expect(streams.get(stream.id).agent.status).toBe('done');

    const said = await attachService.say(stream.id, 'one more thing');
    expect(said.prompted).toBe(session.id);
    expect(said.started).toBeUndefined();
    await waitFor(() => prompts().some((p) => p.includes('one more thing')));
    await waitFor(
      () => threadBodies(stream.id).filter((b) => b === TURN_FINISHED_LINE).length === 2,
    );
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toContain('The operator wrote on the stream: one more thing');
    const after = streams.get(stream.id);
    expect(after.sessions.map((s) => s.id)).toEqual([session.id]);
    expect(after.agent.status).toBe('done');
    expect(store.readDeliveries(stream.id).at(-1)?.session).toBe(session.id);
    expect(threadBodies(stream.id).some((b) => b.startsWith('session ended:'))).toBe(false);
  }, 30_000);

  test('a routed event that would not wake the node waits for its next turn, not the resting session', async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log() }),
      { deliveryDelayMs: 5 },
    );
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await attachService.createNode('human', {
      title: 'Plan',
      goal: 'g',
      project: project.id,
    });
    const session = streams.get(node.id).sessions[0]?.id as string;
    await waitFor(() => statusOf(node.id, session) === 'idle');
    // `ci_failed` wakes no conversation (P11): it is pending, the session stays idle.
    await new RoutedEventService(store).emit({
      type: 'ci_failed',
      subject: node.id,
      payload: { pr: 7, check: 'unit tests' },
      by: 'daemon',
      routing: [{ node: node.id, because: 'self' }],
    });
    attachService.wakePending();
    await Bun.sleep(200);
    expect(prompts()).toHaveLength(1);
    expect(statusOf(node.id, session)).toBe('idle');
    expect(store.readDeliveries(node.id).map((d) => d.status)).toEqual(['pending']);
    // Your next line brings it, in the same session.
    await attachService.say(node.id, 'anything new?');
    await waitFor(() => prompts().length === 2);
    // One digest carries both: the line and the event that was waiting.
    expect(prompts()[1]).toContain('anything new?');
    expect(prompts()[1]).toContain('unit tests');
    await waitFor(() => {
      const latest = new Map(store.readDeliveries(node.id).map((d) => [d.event, d.status]));
      return latest.size === 2 && [...latest.values()].every((status) => status === 'delivered');
    });
    expect(streams.get(node.id).sessions).toHaveLength(1);
  }, 30_000);

  test('the idle timeout ends it; the node stays done and the thread says why in words', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS), {
      sessionIdleMs: 50,
    });
    const stream = await makeStream();
    const { session, handle } = await attachService.attach(stream.id);
    await handle.exited;
    await waitFor(() => statusOf(stream.id, session.id) === 'stopped');
    const after = streams.get(stream.id);
    expect(after.agent.status).toBe('done');
    const ended = after.sessions[0];
    expect(ended?.ended_reason).toBe(`stopped: ${idleEndReason(50)}`);
    expect(ended?.acp_session_id).toBe('fake-session-1');
    await waitFor(() => threadBodies(stream.id).includes(`session ended: ${idleEndReason(50)}`));
    expect(threadBodies(stream.id)).toContain(TURN_FINISHED_LINE);
    // Finished work, not a stop of yours: its next event still wakes it.
    expect(stoppedByHuman(after)).toBe(false);
    expect(store.listAgents().some((a) => a.id === session.id)).toBe(false);
    expect(idleEndReason(30 * 60_000)).toBe('it sat idle for 30 minutes after its turn finished');
  }, 20_000);

  test('the home setting sets the timeout: 30 minutes by default', async () => {
    const rest = (service: AttachService) => (service as unknown as { idleMs(): number }).idleMs();
    expect(rest(buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS)))).toBe(
      30 * 60_000,
    );
    await store.setSessionIdleMinutes(5, { by: 'human' });
    expect(store.getHomeConfig().session_idle_minutes).toBe(5);
    expect(rest(buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS)))).toBe(
      5 * 60_000,
    );
    await store.setSessionIdleMinutes(30, { by: 'human' });
    expect(store.getHomeConfig().session_idle_minutes).toBeUndefined();
  });

  test('an ended session resumes with session/load; the new message goes instead of the brief', async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        ...SPEAKS,
        logFile: log(),
        // What a vendor re-sends on load: already on the thread, never again.
        loadReplay: 'looking at the parser now',
      }),
      { deliveryDelayMs: 5, sessionIdleMs: 0 },
    );
    const stream = await lineStarts();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => statusOf(stream.id, session.id) === 'stopped');

    const said = await attachService.say(stream.id, 'pick it up again', { start: true });
    expect(said.started).toBe(true);
    await waitFor(() => prompts().length === 2);
    expect(loads()).toHaveLength(1);
    expect(loads()[0]).toContain('"sessionId":"fake-session-1"');
    const second = prompts()[1] ?? '';
    expect(second).toContain('The operator wrote on the stream: pick it up again');
    // The digest, not the brief: no goal, no "what woke you".
    expect(second).not.toContain('decide the dialect and implement it');
    expect(second).not.toContain('What woke you');
    await waitFor(() => threadBodies(stream.id).includes(RESUMED_LINE));
    const sessions = streams.get(stream.id).sessions;
    expect(sessions).toHaveLength(2);
    await waitFor(() => streams.get(stream.id).sessions[1]?.acp_session_id === 'fake-session-1');
    // Said once by the first session, once by the resumed turn; the replay adds nothing.
    await waitFor(
      () => threadBodies(stream.id).filter((b) => b === TURN_FINISHED_LINE).length === 2,
    );
    expect(threadBodies(stream.id).filter((b) => b === 'looking at the parser now')).toHaveLength(
      2,
    );
    expect(store.readDeliveries(stream.id).at(-1)?.session).toBe(sessions[1]?.id);
  }, 30_000);

  test('a load that fails starts fresh from the brief, and the thread and stderr.log say so', async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        ...SPEAKS,
        logFile: log(),
        loadFails: 'Session not found',
      }),
      { deliveryDelayMs: 5, sessionIdleMs: 0 },
    );
    const stream = await lineStarts();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => statusOf(stream.id, session.id) === 'stopped');

    await attachService.say(stream.id, 'try again', { start: true });
    await waitFor(() => prompts().length === 2);
    expect(loads()).toHaveLength(1);
    const second = prompts()[1] ?? '';
    expect(second).toContain('decide the dialect and implement it');
    expect(second).toContain('What woke you');
    expect(second).toContain('try again');
    await waitFor(() =>
      threadBodies(stream.id).some((b) =>
        b.startsWith('could not resume its earlier session (Session not found'),
      ),
    );
    expect(threadBodies(stream.id)).not.toContain(RESUMED_LINE);
    const fresh = streams.get(stream.id).sessions[1]?.id as string;
    const stderr = readFileSync(join(home, 'sessions', fresh, 'stderr.log'), 'utf8');
    expect(stderr).toContain('session/load failed, starting fresh with the brief');
  }, 30_000);

  test('T495: a resting agent whose CLI was updated in place starts again on it, resumed, with the line', async () => {
    const bin = join(scratch, 'claude-cli');
    writeFileSync(bin, '#!/bin/sh\necho 1.0.0\n');
    const installed = {
      vendor: 'claude' as const,
      label: 'Claude Code',
      path: bin,
      env: { CLAUDE_CODE_EXECUTABLE: bin },
    };
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log() }),
      {
        deliveryDelayMs: 5,
        installedCli: (vendor) => (vendor === 'claude' ? installed : undefined),
      },
    );
    const stream = await lineStarts();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => statusOf(stream.id, session.id) === 'idle');

    // Unchanged: the resting session takes the line, as before.
    await attachService.say(stream.id, 'first');
    await waitFor(() => prompts().length === 2);
    await waitFor(() => statusOf(stream.id, session.id) === 'idle');
    expect(streams.get(stream.id).sessions).toHaveLength(1);

    // The CLI is updated in place: the resting process still runs the old one.
    writeFileSync(bin, '#!/bin/sh\necho 1.1.0 (a newer build)\n');
    const said = await attachService.say(stream.id, 'try again');
    expect(said.started).toBe(true);
    await waitFor(() => statusOf(stream.id, session.id) === 'stopped');
    expect(threadBodies(stream.id)).toContain(
      'session ended: Claude Code was updated since this agent started; it starts again on the new version',
    );
    await waitFor(() => prompts().length === 3);
    expect(loads()).toHaveLength(1);
    expect(prompts()[2]).toContain('The operator wrote on the stream: try again');
    const sessions = streams.get(stream.id).sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.vendor).toBe(sessions[0]?.vendor);
    expect(sessions[1]?.model).toBe(sessions[0]?.model);
  }, 30_000);

  test('a picked other model starts fresh, with no session/load', async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log() }),
      { deliveryDelayMs: 5, sessionIdleMs: 0 },
    );
    const stream = await lineStarts();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => statusOf(stream.id, session.id) === 'stopped');
    await attachService.say(stream.id, 'now on sonnet', {
      start: true,
      session: { model: 'claude-sonnet-4-6' },
    });
    await waitFor(() => prompts().length === 2);
    expect(loads()).toHaveLength(0);
    expect(prompts()[1]).toContain('decide the dialect and implement it');
    expect(streams.get(stream.id).sessions[1]?.model).toBe('claude-sonnet-4-6');
  }, 30_000);

  test('resumableSession: the vendor loads sessions, the last one ended cleanly with its id, nothing changed', () => {
    const base: SessionRef = {
      id: ulid(),
      vendor: 'claude',
      model: 'claude-opus-4-8',
      role: 'worker',
      status: 'stopped',
      effort: 'low',
      acp_session_id: 'acp-1',
    };
    const settings = { vendor: 'claude', model: 'claude-opus-4-8', effort: 'low' };
    const claude = ACP_PROVIDERS.claude;
    const of = (s: Partial<SessionRef>) => ({ sessions: [{ ...base, ...s }] });
    expect(resumableSession(of({}), 'worker', settings, claude)?.acp_session_id).toBe('acp-1');
    expect(resumableSession(of({}), 'worker', settings, ACP_PROVIDERS.gemini)).toBeUndefined();
    expect(
      resumableSession(of({ acp_session_id: undefined }), 'worker', settings, claude),
    ).toBeUndefined();
    expect(resumableSession(of({ status: 'error' }), 'worker', settings, claude)).toBeUndefined();
    expect(
      resumableSession(of({ model: 'claude-sonnet-4-6' }), 'worker', settings, claude),
    ).toBeUndefined();
    expect(resumableSession(of({ effort: 'high' }), 'worker', settings, claude)).toBeUndefined();
    expect(resumableSession(of({}), 'coordinator', settings, claude)).toBeUndefined();
    expect(resumableSession(of({}), 'reviewer', settings, claude)).toBeUndefined();
  });

  test('a merge goes through with a resting session, and ends it', async () => {
    streams = new StreamService(store, {
      onUpdated: (before, after) => attachService.onNodeUpdated(before, after),
    });
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS));
    await store.putRepos({ demo: { path: repo, protected_branches: [] } });
    const landing = new DeliveryService({ store, streams });
    const stream = await makeStream('demo');
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => statusOf(stream.id, session.id) === 'idle');
    const wt = streams.get(stream.id).worktree as string;
    writeFileSync(join(wt, 'parser.ts'), 'export const dialect = ";";\n');
    git(['add', 'parser.ts'], wt);
    git(['commit', '-q', '-m', 'parser'], wt);

    expect(landing.preflight(stream.id).ready).toBe(true);
    expect((await landing.land(stream.id)).status).toBe('landed');
    const after = streams.get(stream.id);
    expect(after.human.status).toBe('landed');
    expect(after.agent.status).toBe('done');
    expect(statusOf(stream.id, session.id)).toBe('stopped');
    expect(threadBodies(stream.id)).toContain('session ended: the node was merged');
    expect(attachService.handleFor(stream.id)).toBeUndefined();
  }, 30_000);

  test('a working agent still holds a merge', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    await store.putRepos({ demo: { path: repo, protected_branches: [] } });
    const landing = new DeliveryService({ store, streams });
    const stream = await makeStream('demo');
    await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).includes('looking at the parser now'));
    expect(landing.preflight(stream.id).reason).toContain('still has a live agent');
  }, 30_000);

  test('auto-close counts a goal met in the turn that just ended, not in an earlier one', async () => {
    const turnOne = join(scratch, 'goal-one.flag');
    const turnThree = join(scratch, 'goal-three.flag');
    // Wired as `daemon.ts` wires them: auto-close and the attach service follow each update.
    const autoClose = new AutoClose({
      streams: {
        get: (id) => streams.get(id),
        list: () => streams.list(),
        close: (principal, id, note) => streams.close(principal, id, note),
      },
      preflight: () => ({}),
      uncommitted: () => false,
    });
    streams = new StreamService(store, {
      onUpdated: async (before, after) => {
        void autoClose.onUpdated(before, after);
        await attachService.onNodeUpdated(before, after);
      },
    });
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        logFile: log(),
        steps: [{ type: 'agent_text', text: 'a small follow-up' }, { type: 'end_turn' }],
        turns: [
          [
            { type: 'tool_call', toolCallId: 'goal-1', title: 'goal_met' },
            { type: 'wait_for_file', path: turnOne },
            { type: 'end_turn' },
          ],
          [{ type: 'agent_text', text: 'a small follow-up' }, { type: 'end_turn' }],
          [
            { type: 'tool_call', toolCallId: 'goal-3', title: 'goal_met' },
            { type: 'wait_for_file', path: turnThree },
            { type: 'end_turn' },
          ],
        ],
      }),
      { deliveryDelayMs: 5 },
    );
    const parent = await streams.create('human', { title: 'Parser work', goal: 'g' });
    const node = await streams.create('human', {
      title: 'CSV parser',
      goal: 'decide the dialect and implement it',
      parent: parent.id,
    });
    const { session } = await attachService.attach(node.id);
    await waitFor(() => store.listAgents().some((a) => a.id === session.id));
    // Turn one says its goal is met while the node is not set to close itself.
    await verbs.goalMet({ session: session.id, summary: 'dialect decided' });
    writeFileSync(turnOne, '');
    await waitFor(() => statusOf(node.id, session.id) === 'idle');
    expect(streams.get(node.id).human.status).toBe('open');

    // Now set to auto-close: turn two says nothing about the goal, so it stays open.
    await streams.update('human', node.id, { auto_close: true });
    await attachService.say(node.id, 'one small thing');
    await waitFor(() => streams.get(node.id).agent.goal_met === undefined);
    await waitFor(() => threadBodies(node.id).includes('a small follow-up'));
    await waitFor(() => threadBodies(node.id).filter((b) => b === TURN_FINISHED_LINE).length === 2);
    await Bun.sleep(100);
    expect(streams.get(node.id).human.status).toBe('open');

    // Turn three meets it again, in its own turn: the node closes, and its session ends.
    await attachService.say(node.id, 'wrap it up');
    await waitFor(() => prompts().length === 3);
    await verbs.goalMet({ session: session.id, summary: 'all done' });
    writeFileSync(turnThree, '');
    await waitFor(() => streams.get(node.id).human.status === 'closed');
    await waitFor(() => statusOf(node.id, session.id) === 'stopped');
    expect(threadBodies(node.id)).toContain('session ended: the node was closed');
    expect(streams.get(node.id).agent.status).toBe('done');
  }, 30_000);

  test('the daemon stopping ends it with the node still done; after a restart the next message resumes it', async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log() }),
      { deliveryDelayMs: 5 },
    );
    const stream = await lineStarts();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => statusOf(stream.id, session.id) === 'idle');
    await attachService.stopAll();
    const after = streams.get(stream.id);
    expect(after.agent.status).toBe('done');
    expect(after.sessions[0]?.ended_reason).toBe(`stopped: ${DAEMON_SHUTDOWN_REASON}`);
    expect(threadBodies(stream.id)).toContain(`session ended: ${DAEMON_SHUTDOWN_REASON}`);

    // The next daemon: its first message resumes the session.
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log() }),
      { deliveryDelayMs: 5 },
    );
    await attachService.say(stream.id, 'back again', { start: true });
    await waitFor(() => prompts().length === 2);
    expect(loads()).toHaveLength(1);
    expect(prompts()[1]).toContain('back again');
  }, 30_000);

  test('T444: an idle session a dead daemon left ends at start; its node stays done', async () => {
    const stream = await makeStream();
    const id = ulid();
    await store.updateStream('daemon', stream.id, (before) => ({
      ...before,
      agent: { ...before.agent, status: 'done' },
      sessions: [
        {
          id,
          vendor: 'claude',
          model: 'claude-opus-4-8',
          role: 'worker',
          status: 'idle',
          acp_session_id: 'acp-left',
        },
      ],
    }));
    expect(await attachService.endOrphansAtStart()).toEqual([stream.id]);
    const after = streams.get(stream.id);
    expect(after.agent.status).toBe('done');
    expect(after.sessions[0]?.status).toBe('stopped');
    expect(after.sessions[0]?.ended_reason).toBe(`stopped: ${DAEMON_RESTART_IDLE_REASON}`);
    expect(threadBodies(stream.id)).toContain(`session ended: ${DAEMON_RESTART_IDLE_REASON}`);
  });

  test('your Stop ends it and the node stays done; a role change ends it without a restart', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS));
    const stopped = await makeStream();
    const first = await attachService.attach(stopped.id);
    await waitFor(() => statusOf(stopped.id, first.session.id) === 'idle');
    expect(await attachService.stop(stopped.id, undefined, { detach: true })).toEqual([
      first.session.id,
    ]);
    expect(streams.get(stopped.id).agent.status).toBe('done');
    expect(threadBodies(stopped.id)).toContain('worker detached by human');

    streams = new StreamService(store, {
      onTreeChanged: (nodes) => attachService.followRoles(nodes),
    });
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS));
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const node = await attachService.createNode('human', {
      title: 'Checkout',
      goal: 'g',
      project: project.id,
      repo: 'demo',
    });
    const worker = streams.get(node.id).sessions[0]?.id as string;
    await waitFor(() => statusOf(node.id, worker) === 'idle');
    await attachService.createNode('human', {
      title: 'Cart API',
      goal: 'g',
      parent: node.id,
      repo: 'demo',
      start: false,
    });
    await waitFor(() => statusOf(node.id, worker) === 'stopped');
    expect(streams.get(node.id).sessions).toHaveLength(1);
    expect(streams.get(node.id).agent.status).toBe('done');
    expect(threadBodies(node.id)).toContain('session ended: role changed to coordinating');
  }, 30_000);
});

describe("T488: Codex's effort goes through its own ACP option", () => {
  const log = () => join(scratch, 't488.jsonl');
  const logLines = (): Array<Record<string, unknown> & { method: string }> =>
    (existsSync(log()) ? readFileSync(log(), 'utf8') : '')
      .split('\n')
      // T492: complete lines only; the agent may be mid-write.
      .slice(0, -1)
      .map((l) => JSON.parse(l));
  const prompts = () => logLines().filter((l) => l.method === 'session/prompt');
  const sets = () =>
    logLines()
      .filter((l) => l.method === 'session/set_config_option')
      .map((l) => l.params as { sessionId: string; configId: string; value: string });
  /** Codex's shape (LIVE-CHECKLIST §12): `reasoning_effort`, category `thought_level`. */
  const CODEX_EFFORT = {
    id: 'reasoning_effort',
    current: 'low',
    values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  };
  const codex = (extra: Partial<FakeAgentScript> = {}) =>
    fakeProviderFor(ACP_PROVIDERS.codex, {
      ...SPEAKS,
      logFile: log(),
      modelOption: {
        current: 'gpt-6-astra',
        options: [
          { value: 'gpt-6-astra', name: 'GPT-6-Astra' },
          { value: 'gpt-5.5', name: 'GPT-5.5' },
        ],
      },
      effortOption: CODEX_EFFORT,
      ...extra,
    });
  const sessionOf = (streamId: string, session: string) =>
    streams.get(streamId).sessions.find((s) => s.id === session);

  test('the picked level is set before the first prompt, after the model, and recorded', async () => {
    attachService = buildAttachService(codex());
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id, {
      vendor: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
    });
    await waitFor(() => prompts().length === 1);
    expect(sets()).toEqual([
      { sessionId: 'fake-session-1', configId: 'model', value: 'gpt-5.5' },
      { sessionId: 'fake-session-1', configId: 'reasoning_effort', value: 'high' },
    ]);
    const order = logLines().map((l) => l.method);
    expect(order.lastIndexOf('session/set_config_option')).toBeLessThan(
      order.indexOf('session/prompt'),
    );
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(sessionOf(stream.id, session.id)?.effort).toBe('high');
    // Codex takes effort now: no "effort … ignored by codex" line.
    expect(threadBodies(stream.id).some((b) => b.includes('ignored by codex'))).toBe(false);
    // T506: its commands go through its own hook now: no unchecked line.
    expect(threadBodies(stream.id).some((b) => b.includes('runs commands unchecked'))).toBe(false);
    expect(
      threadBodies(stream.id).some((b) => /did not take|refused effort|doesn't offer/.test(b)),
    ).toBe(false);
  }, 30_000);

  test('the level it already runs is not sent', async () => {
    attachService = buildAttachService(codex());
    const stream = await makeStream();
    await attachService.attach(stream.id, { vendor: 'codex', model: 'gpt-6-astra', effort: 'low' });
    await waitFor(() => prompts().length === 1);
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(sets()).toEqual([]);
  }, 30_000);

  test('a level the vendor kept says so, and the session records what it runs', async () => {
    attachService = buildAttachService(codex({ setConfigOption: 'ignore' }));
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id, {
      vendor: 'codex',
      model: 'gpt-6-astra',
      effort: 'max',
    });
    await waitFor(() =>
      threadBodies(stream.id).includes('Codex kept effort low; it did not take max'),
    );
    await waitFor(() => sessionOf(stream.id, session.id)?.effort === 'low');
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(prompts()).toHaveLength(1);
  }, 30_000);

  test('a refusal says why, and the session carries on', async () => {
    attachService = buildAttachService(codex({ setConfigOption: 'error' }));
    const stream = await makeStream();
    await attachService.attach(stream.id, {
      vendor: 'codex',
      model: 'gpt-6-astra',
      effort: 'medium',
    });
    await waitFor(() =>
      threadBodies(stream.id).some((b) =>
        b.startsWith('Codex refused effort medium (cannot set reasoning_effort); it runs low'),
      ),
    );
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(prompts()).toHaveLength(1);
  }, 30_000);

  test('a level it does not list is not sent, and the thread says what it runs', async () => {
    attachService = buildAttachService(
      codex({
        effortOption: { id: 'reasoning_effort', current: 'medium', values: ['low', 'medium'] },
      }),
    );
    const stream = await makeStream();
    await attachService.attach(stream.id, { vendor: 'codex', model: 'gpt-6-astra', effort: 'max' });
    await waitFor(() =>
      threadBodies(stream.id).includes("Codex doesn't offer effort max; it runs medium"),
    );
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(sets()).toEqual([]);
  }, 30_000);

  test('Cursor still has no effort: the level is recorded as ignored, never sent', async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.cursor, {
        ...SPEAKS,
        logFile: log(),
        requireAuthMethod: 'cursor_login',
      }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id, { vendor: 'cursor', effort: 'high' });
    await waitFor(() => prompts().length === 1);
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(threadBodies(stream.id)).toContain('effort high ignored by cursor');
    expect(sets()).toEqual([]);
    expect(sessionOf(stream.id, session.id)?.effort).toBeUndefined();
  }, 30_000);
});

describe('T467 (D46): models come from the vendor, set through ACP', () => {
  const log = () => join(scratch, 't467.jsonl');
  const logLines = (): Array<Record<string, unknown> & { method: string }> =>
    (existsSync(log()) ? readFileSync(log(), 'utf8') : '')
      .split('\n')
      // T492: complete lines only; the agent may be mid-write.
      .slice(0, -1)
      .map((l) => JSON.parse(l));
  const methods = () => logLines().map((l) => l.method);
  const prompts = () => logLines().filter((l) => l.method === 'session/prompt');
  const sets = () => logLines().filter((l) => l.method === 'session/set_config_option');
  /** Cursor's shape (LIVE-CHECKLIST §12): "Auto" is current, values carry their settings. */
  const CURSOR_MODELS = {
    current: 'default[]',
    options: [
      { value: 'default[]', name: 'Auto' },
      { value: 'grok-4.7[context=256k,fast=true]', name: 'grok-4.7' },
      { value: 'gpt-5.5[context=272k]', name: 'gpt-5.5' },
    ],
  };
  const cursor = (extra: Partial<FakeAgentScript> = {}) =>
    fakeProviderFor(ACP_PROVIDERS.cursor, {
      ...SPEAKS,
      logFile: log(),
      requireAuthMethod: 'cursor_login',
      modelOption: CURSOR_MODELS,
      ...extra,
    });
  const modelOf = (streamId: string, session: string) =>
    streams.get(streamId).sessions.find((s) => s.id === session)?.model;

  test('a pick the vendor lists is set through its model option before the first prompt', async () => {
    const models = new ModelCatalog({ home });
    attachService = buildAttachService(cursor(), { models });
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id, {
      vendor: 'cursor',
      model: 'grok-4.7[context=256k,fast=true]',
    });
    await waitFor(() => prompts().length === 1);
    // Authenticated, opened, then the model, then the brief: the first turn runs on the pick.
    expect(methods()).toEqual([
      'authenticate',
      'session/set_mode',
      'session/set_config_option',
      'session/prompt',
    ]);
    expect(sets()[0]?.params).toEqual({
      sessionId: 'fake-session-1',
      configId: 'model',
      value: 'grok-4.7[context=256k,fast=true]',
    });
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(modelOf(stream.id, session.id)).toBe('grok-4.7[context=256k,fast=true]');
    expect(threadBodies(stream.id).some((b) => b.includes('did not take'))).toBe(false);
    // The file says what the vendor runs now; the catalog kept the vendor's list.
    const saved = JSON.parse(
      readFileSync(join(home, 'sessions', session.id, SESSION_STATE_FILE), 'utf8'),
    ) as { vendor: string; source: string; configOptions: Array<{ currentValue: string }> };
    expect(saved).toMatchObject({ vendor: 'cursor', source: 'session/set_config_option' });
    expect(saved.configOptions[0]?.currentValue).toBe('grok-4.7[context=256k,fast=true]');
    expect(models.get('cursor')?.options.map((o) => o.name)).toEqual([
      'Auto',
      'grok-4.7',
      'gpt-5.5',
    ]);
    expect(models.get('cursor')?.current).toBe('grok-4.7[context=256k,fast=true]');
  }, 30_000);

  test('an ignored pick says so on the thread, and the session records what the vendor runs', async () => {
    attachService = buildAttachService(cursor({ setConfigOption: 'ignore' }));
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id, {
      vendor: 'cursor',
      model: 'gpt-5.5[context=272k]',
    });
    await waitFor(() => prompts().length === 1);
    expect(sets()).toHaveLength(1);
    await waitFor(() =>
      threadBodies(stream.id).includes('Cursor kept its own model (Auto); it did not take gpt-5.5'),
    );
    await waitFor(() => modelOf(stream.id, session.id) === 'default[]');
    // Never a failed session over it: the turn ran and finished.
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    const stderr = readFileSync(join(home, 'sessions', session.id, 'stderr.log'), 'utf8');
    expect(stderr).toContain('did not take gpt-5.5');
  }, 30_000);

  test('a refused pick says why, and the session carries on', async () => {
    attachService = buildAttachService(cursor({ setConfigOption: 'error' }));
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id, {
      vendor: 'cursor',
      model: 'gpt-5.5[context=272k]',
    });
    await waitFor(() =>
      threadBodies(stream.id).some((b) =>
        b.startsWith('Cursor refused the model gpt-5.5 (cannot set model); it runs Auto'),
      ),
    );
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(prompts()).toHaveLength(1);
    expect(modelOf(stream.id, session.id)).toBe('default[]');
  }, 30_000);

  test("Claude's ANTHROPIC_MODEL path is unchanged: a full id is not the bridge's to set", async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        ...SPEAKS,
        logFile: log(),
        logModelEnv: true,
        // The bridge's list (LIVE-CHECKLIST §12): aliases, and the current model.
        modelOption: {
          current: 'claude-opus-5-5',
          options: [
            { value: 'default', name: 'Default (recommended)' },
            { value: 'opus[1m]', name: 'Opus 5.5' },
            { value: 'sonnet', name: 'Sonnet' },
          ],
        },
      }),
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id, { model: 'claude-sonnet-4-6' });
    await waitFor(() => prompts().length === 1);
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(logLines()[0]).toEqual({ method: 'spawn', ANTHROPIC_MODEL: 'claude-sonnet-4-6' });
    expect(sets()).toHaveLength(0);
    expect(modelOf(stream.id, session.id)).toBe('claude-sonnet-4-6');
    expect(threadBodies(stream.id).some((b) => b.includes('its own model'))).toBe(false);
  }, 30_000);

  test('T486: a vendor session never sees the classifier key, even when the daemon has it', async () => {
    const before = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'test-only-not-a-real-key';
    try {
      attachService = buildAttachService(
        fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log(), logSecretEnv: true }),
      );
      const stream = await makeStream();
      await attachService.attach(stream.id);
      await waitFor(() => prompts().length === 1);
      expect(logLines()[0]).toEqual({ method: 'spawn-secrets', classifier_key: false });
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, 'TYPESAFE_API_KEY');
      else process.env.TYPESAFE_API_KEY = before;
    }
  }, 30_000);

  test('T480 (D49): the bridge runs the installed CLI, and stderr.log says which', async () => {
    const installed = {
      vendor: 'claude' as const,
      label: 'Claude Code',
      path: '/usr/local/bin/claude',
      env: { CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude' },
    };
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log(), logModelEnv: true }),
      { installedCli: (vendor) => (vendor === 'claude' ? installed : undefined) },
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id);
    await waitFor(() => prompts().length === 1);
    expect(logLines()[0]).toMatchObject({
      method: 'spawn',
      CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude',
    });
    await waitFor(() =>
      readFileSync(join(home, 'sessions', session.id, 'stderr.log'), 'utf8').includes(
        'running your installed Claude Code: /usr/local/bin/claude',
      ),
    );
  }, 30_000);

  test("a Claude pick from the bridge's own list goes through the option when it isn't current", async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, {
        ...SPEAKS,
        logFile: log(),
        logModelEnv: true,
        modelOption: {
          current: 'default',
          options: [
            { value: 'default', name: 'Default (recommended)' },
            { value: 'sonnet', name: 'Sonnet' },
          ],
        },
      }),
    );
    const stream = await makeStream();
    await attachService.attach(stream.id, { model: 'sonnet' });
    await waitFor(() => prompts().length === 1);
    // ANTHROPIC_MODEL as before, and the option as well: the bridge said it ran another.
    expect(logLines()[0]).toEqual({ method: 'spawn', ANTHROPIC_MODEL: 'sonnet' });
    expect(sets().map((s) => (s.params as { value?: string } | undefined)?.value)).toEqual([
      'sonnet',
    ]);
  }, 30_000);

  test('a vendor with no model option: nothing is set, nothing is said, the catalog stays empty', async () => {
    const models = new ModelCatalog({ home });
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.gemini, { ...SPEAKS, logFile: log() }),
      { models },
    );
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id, {
      vendor: 'gemini',
      model: 'gemini-3-pro',
    });
    await waitFor(() => prompts().length === 1);
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(sets()).toHaveLength(0);
    expect(modelOf(stream.id, session.id)).toBe('gemini-3-pro');
    expect(models.all()).toEqual({});
  }, 30_000);

  test('a resumed session gets the pick too, after session/load and before the new message', async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.codex, {
        ...SPEAKS,
        logFile: log(),
        modelOption: {
          current: 'gpt-6-astra',
          options: [
            { value: 'gpt-6-astra', name: 'GPT-6-Astra' },
            { value: 'gpt-5.5', name: 'GPT-5.5' },
          ],
        },
      }),
      { deliveryDelayMs: 5, sessionIdleMs: 0 },
    );
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const stream = await attachService.createNode('human', {
      title: 'CSV parser',
      goal: 'decide the dialect and implement it',
      project: project.id,
      start: false,
    });
    const { session } = await attachService.attach(stream.id, {
      vendor: 'codex',
      model: 'gpt-5.5',
    });
    await waitFor(() => streams.get(stream.id).sessions[0]?.status === 'stopped');
    expect(modelOf(stream.id, session.id)).toBe('gpt-5.5');

    await attachService.say(stream.id, 'pick it up again', { start: true });
    await waitFor(() => prompts().length === 2);
    await waitFor(() => threadBodies(stream.id).includes(RESUMED_LINE));
    expect(methods().filter((m) => m !== 'session/set_mode')).toEqual([
      'session/set_config_option',
      'session/prompt',
      'session/load',
      'session/set_config_option',
      'session/prompt',
    ]);
  }, 30_000);
});

describe('T482: model routing at a start (the policy and the lock)', () => {
  const PRESETS = [
    { vendor: 'claude' as const, model: 'claude-haiku-4-5' },
    { vendor: 'claude' as const, model: 'claude-sonnet-5-5' },
    { vendor: 'claude' as const, model: 'claude-opus-5-5' },
  ];

  async function projectWith(policy: Record<string, unknown>) {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    await store.updateProject(project.id, (p) => ({ ...p, model_policy: policy }));
    return project;
  }

  function lastSession(id: string): SessionRef | undefined {
    return streams.get(id).sessions.at(-1);
  }

  function modelLines(id: string): string[] {
    return threadBodies(id).filter((b) => b.startsWith('Model: ') || b.startsWith('Running '));
  }

  test('a routed first start is the policy’s pick; a later start keeps it; choose again picks afresh', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS));
    const project = await projectWith({ mode: 'choose', presets: PRESETS });
    const node = await streams.create('human', { title: 'Parser', goal: 'g', project: project.id });

    // First start, no pick: routed. Choose with no classifier (T483): the cheapest balanced preset, medium.
    await attachService.attach(node.id);
    await waitFor(() => streams.get(node.id).agent.status === 'done');
    expect(lastSession(node.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(modelLines(node.id)).toEqual([
      'Model: Claude Sonnet 5.5 · medium — start cheap: balanced (no classifier key)',
    ]);
    expect(streams.get(node.id).agent.pick).toMatchObject({
      vendor: 'claude',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      how: 'rule',
      session: lastSession(node.id)?.id,
    });

    // The policy changes; a later start (a wake, a line) keeps the node's pick (D55).
    await store.updateProject(project.id, (p) => ({
      ...p,
      model_policy: { mode: 'choose', presets: PRESETS, escalation: 'strongest_first' },
    }));
    await attachService.startWithPending(node.id);
    await waitFor(
      () =>
        streams.get(node.id).sessions.length === 2 && streams.get(node.id).agent.status === 'done',
    );
    expect(lastSession(node.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(modelLines(node.id)).toHaveLength(1);
    // The record still says how the model was first picked.
    expect(streams.get(node.id).agent.pick?.how).toBe('rule');

    // Let the policy choose again: the next start picks afresh, once.
    await streams.chooseModelAgain(node.id);
    expect(streams.get(node.id).human.choose_again).toBe(true);
    await attachService.attach(node.id);
    await waitFor(
      () =>
        streams.get(node.id).sessions.length === 3 && streams.get(node.id).agent.status === 'done',
    );
    expect(lastSession(node.id)).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(streams.get(node.id).human.choose_again).toBeUndefined();
    expect(modelLines(node.id).at(-1)).toBe(
      'Model: Claude Opus 5.5 · high — strongest first: the strongest preset model (no classifier key)',
    );
  }, 30_000);

  test('choose again ends a resting session, so the next message starts on a fresh routed pick', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS));
    const project = await projectWith({ mode: 'default', presets: [] });
    const node = await streams.create('human', { title: 'Parser', goal: 'g', project: project.id });
    await attachService.attach(node.id);
    await waitFor(() => isRestingSession(streams.get(node.id), lastSession(node.id) as SessionRef));
    expect(lastSession(node.id)?.model).toBe('claude-opus-5-5');

    await store.updateProject(project.id, (p) => ({
      ...p,
      model_policy: { mode: 'choose', presets: PRESETS },
    }));
    await attachService.routing().chooseAgain(node.id);
    await waitFor(() => lastSession(node.id)?.status === 'stopped');
    expect(lastSession(node.id)?.ended_reason ?? threadBodies(node.id).join('\n')).toContain(
      'choose again',
    );
    await attachService.say(node.id, 'carry on', { start: true });
    await waitFor(() => streams.get(node.id).sessions.length === 2);
    expect(lastSession(node.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(streams.get(node.id).human.choose_again).toBeUndefined();
  }, 30_000);

  test('an explicit pick wins, outside the presets too, and says it runs as picked (D53)', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS));
    const project = await projectWith({
      mode: 'choose',
      presets: [{ vendor: 'claude', model: 'claude-sonnet-5-5' }],
      effort_ceiling: 'low',
    });
    const node = await streams.create('human', { title: 'Parser', goal: 'g', project: project.id });
    await attachService.attach(node.id, { model: 'claude-opus-4-8', effort: 'max' });
    await waitFor(() => streams.get(node.id).agent.status === 'done');
    expect(lastSession(node.id)).toMatchObject({ model: 'claude-opus-4-8', effort: 'max' });
    expect(modelLines(node.id)).toEqual([
      'Running Claude Opus 4.8, as you picked. Routed picks here use this project’s preset models.',
    ]);
    expect(streams.get(node.id).agent.pick).toMatchObject({ how: 'explicit', why: 'your pick' });

    // Inside the presets: no line at all.
    const inside = await streams.create('human', { title: 'Two', goal: 'g', project: project.id });
    await attachService.attach(inside.id, { model: 'claude-sonnet-5-5' });
    await waitFor(() => streams.get(inside.id).agent.status === 'done');
    expect(modelLines(inside.id)).toEqual([]);
  }, 30_000);

  test('inherit copies the parent’s current pick, under the effort ceiling', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS));
    const project = await projectWith({ mode: 'inherit', presets: [], effort_ceiling: 'medium' });
    const parent = await streams.create('human', {
      title: 'Billing',
      goal: 'g',
      project: project.id,
    });
    await attachService.attach(parent.id, { model: 'claude-haiku-4-5', effort: 'high' });
    await waitFor(() => streams.get(parent.id).agent.status === 'done');
    const child = await streams.create('human', {
      title: 'Invoices',
      goal: 'g',
      project: project.id,
      parent: parent.id,
    });
    await attachService.attach(child.id);
    await waitFor(() => streams.get(child.id).agent.status === 'done');
    expect(lastSession(child.id)).toMatchObject({ model: 'claude-haiku-4-5', effort: 'medium' });
    expect(streams.get(child.id).agent.pick).toMatchObject({ how: 'clamp', base: 'inherit' });
    expect(modelLines(child.id)).toEqual([
      'Model: Claude Haiku 4.5 · medium — inherited from Billing, clamped. Effort high is over the ceiling, so medium.',
    ]);
  }, 30_000);

  test('Default resolves as today, clamped into the presets; a carried restart asks no policy', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS));
    const project = await projectWith({
      mode: 'default',
      presets: [{ vendor: 'claude', model: 'claude-sonnet-5-5' }],
    });
    const node = await streams.create('human', { title: 'Parser', goal: 'g', project: project.id });
    await attachService.attach(node.id);
    await waitFor(() => streams.get(node.id).agent.status === 'done');
    // The built-in default (Opus 5.5 · low) isn't a preset: the nearest one runs.
    expect(lastSession(node.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
    expect(modelLines(node.id)).toEqual([
      'Model: Claude Sonnet 5.5 · low — the Default setting, clamped. Claude Opus 5.5 isn’t a preset model, so Claude Sonnet 5.5 instead.',
    ]);
    // A daemon restart of the agent (a role change, a crash) carries its model, unasked.
    await attachService.attach(node.id, {
      model: 'claude-opus-5-5',
      carried: 'restarted in its new role',
    });
    await waitFor(
      () =>
        streams.get(node.id).sessions.length === 2 && streams.get(node.id).agent.status === 'done',
    );
    expect(lastSession(node.id)?.model).toBe('claude-opus-5-5');
    expect(modelLines(node.id)).toHaveLength(1);
    expect(streams.get(node.id).agent.pick).toMatchObject({
      how: 'default',
      why: 'restarted in its new role',
    });
  }, 30_000);
});

describe('T483: the chooser at a start (D52, D55)', () => {
  const PRESETS = [
    { vendor: 'claude' as const, model: 'claude-haiku-4-5' },
    { vendor: 'claude' as const, model: 'claude-sonnet-5-5' },
    { vendor: 'claude' as const, model: 'claude-opus-5-5' },
  ];
  const one = (n: string, confidence = 0.9) => ({
    choice: n,
    confidence,
    probabilities: { [n]: 1 },
  });
  /** A clear, checkable, short, low-stakes one-off: Jev picks Sonnet at 0.82. */
  const CLEAR = {
    clarity: one('5'),
    verifiability: one('5'),
    horizon: one('1'),
    stakes: one('1'),
    volume: one('1'),
    topic: one('none'),
    // T490 (D57): Jev answers the tier.
    tier: {
      choice: 'balanced',
      confidence: 0.82,
      probabilities: { balanced: 0.88, fast: 0.12 },
    },
    effort: one('medium', 0.7),
  };
  let projects = 0;

  async function projectWith(policy: Record<string, unknown>) {
    projects += 1;
    const project = await new ProjectService(store, streams).create({ name: `Routed ${projects}` });
    await store.updateProject(project.id, (p) => ({ ...p, model_policy: policy }));
    return project;
  }

  function modelLines(id: string): string[] {
    return threadBodies(id).filter((b) => b.startsWith('Model: '));
  }

  test('a routed first start asks Jev once and runs its pick; a later start doesn’t ask; choose again does', async () => {
    const jev = new FakeClassifier([], { choice: CLEAR });
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS), {
      classifier: jev,
    });
    const project = await projectWith({ mode: 'choose', presets: PRESETS });
    const node = await streams.create('human', {
      title: 'Rename getUser to fetchUser',
      goal: 'Rename it and its call sites; the tests must pass.',
      project: project.id,
    });

    await attachService.attach(node.id);
    await waitFor(() => streams.get(node.id).agent.status === 'done');
    expect(jev.choiceCalls).toHaveLength(1);
    expect(jev.choiceCalls[0]?.state).toContain('Task: Rename getUser to fetchUser');
    expect(streams.get(node.id).sessions.at(-1)).toMatchObject({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
    });
    expect(modelLines(node.id)).toEqual([
      'Model: Claude Sonnet 5.5 · medium — balanced (Jev 0.82): well specified and covered by tests; short, low stakes',
    ]);
    expect(streams.get(node.id).agent.pick).toMatchObject({
      how: 'jev',
      confidence: 0.82,
      tier: 'balanced',
      tier_by: 'jev',
      in_tier: { by: 'only' },
      topic: 'none',
      scores: { clarity: 5, verifiability: 5, horizon: 1, stakes: 1, volume: 1 },
    });

    // A later start (a wake) keeps the node's pick and never asks Jev (D55).
    await attachService.startWithPending(node.id);
    await waitFor(
      () =>
        streams.get(node.id).sessions.length === 2 && streams.get(node.id).agent.status === 'done',
    );
    expect(jev.choiceCalls).toHaveLength(1);
    expect(modelLines(node.id)).toHaveLength(1);

    // Let the policy choose again: the next start asks once more.
    await streams.chooseModelAgain(node.id);
    await attachService.attach(node.id);
    await waitFor(
      () =>
        streams.get(node.id).sessions.length === 3 && streams.get(node.id).agent.status === 'done',
    );
    expect(jev.choiceCalls).toHaveLength(2);
    expect(modelLines(node.id)).toHaveLength(2);
  }, 30_000);

  test('without a key the start runs on the rule and says why; an explicit pick never asks', async () => {
    const keyless = new FakeClassifier();
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS), {
      classifier: keyless,
    });
    const project = await projectWith({ mode: 'choose', presets: PRESETS });
    const node = await streams.create('human', { title: 'Parser', goal: 'g', project: project.id });
    await attachService.attach(node.id);
    await waitFor(() => streams.get(node.id).agent.status === 'done');
    expect(modelLines(node.id)).toEqual([
      'Model: Claude Sonnet 5.5 · medium — start cheap: balanced (no classifier key)',
    ]);
    expect(streams.get(node.id).agent.pick?.scores).toBeUndefined();

    const picked = await streams.create('human', { title: 'Two', goal: 'g', project: project.id });
    await attachService.attach(picked.id, { model: 'claude-haiku-4-5' });
    await waitFor(() => streams.get(picked.id).agent.status === 'done');
    expect(keyless.choiceCalls).toHaveLength(1);
  }, 30_000);

  test('a pinned rule naming reviewer picks a reviewer’s model, without asking Jev', async () => {
    const jev = new FakeClassifier([], { choice: CLEAR });
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS), {
      classifier: jev,
    });
    const project = await projectWith({
      mode: 'choose',
      presets: PRESETS,
      pinned_rules: [
        {
          when: { role: 'reviewer' },
          pick: { vendor: 'claude', model: 'claude-haiku-4-5', effort: 'low' },
        },
      ],
    });
    const node = await streams.create('human', { title: 'Parser', goal: 'g', project: project.id });
    await attachService.attach(node.id, { role: 'reviewer' });
    await waitFor(() => threadBodies(node.id).some((b) => b.startsWith('review finished')));
    expect(streams.get(node.id).sessions[0]).toMatchObject({
      role: 'reviewer',
      model: 'claude-haiku-4-5',
      effort: 'low',
    });
    expect(modelLines(node.id)).toEqual(['Model: Claude Haiku 4.5 · low — pinned rule: reviewer']);
    expect(jev.choiceCalls).toHaveLength(0);
  }, 30_000);
});

describe('T490: a reviewer routed by role, the vendor order (D57, D59)', () => {
  const MIXED = [
    { vendor: 'claude' as const, model: 'claude-haiku-4-5' },
    { vendor: 'claude' as const, model: 'claude-sonnet-5-5' },
    { vendor: 'claude' as const, model: 'claude-opus-5-5' },
    { vendor: 'codex' as const, model: 'gpt-5.6-sol' },
    { vendor: 'codex' as const, model: 'gpt-6-astra' },
  ];
  const one = (n: string, confidence = 0.9) => ({
    choice: n,
    confidence,
    probabilities: { [n]: 1 },
  });
  const CLEAR = {
    clarity: one('5'),
    verifiability: one('5'),
    horizon: one('1'),
    stakes: one('1'),
    volume: one('1'),
    topic: one('none'),
    tier: one('balanced', 0.82),
    effort: one('medium', 0.7),
  };
  let projects = 0;

  async function nodeIn(policy: Record<string, unknown>): Promise<Stream> {
    projects += 1;
    const project = await new ProjectService(store, streams).create({ name: `Tiers ${projects}` });
    await store.updateProject(project.id, (p) => ({ ...p, model_policy: policy }));
    return streams.create('human', { title: 'Parser', goal: 'g', project: project.id });
  }

  test('a reviewer with no pick runs the reviewer order’s model in Jev’s tier; the worker the worker’s', async () => {
    const jev = new FakeClassifier([], { choice: CLEAR });
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS), {
      classifier: jev,
    });
    const node = await nodeIn({
      mode: 'choose',
      presets: MIXED,
      vendor_order: ['claude', 'codex'],
      vendor_order_by_role: { reviewer: ['codex', 'claude'] },
    });
    await attachService.attach(node.id, { role: 'reviewer' });
    await waitFor(() => threadBodies(node.id).some((b) => b.startsWith('review finished')));
    expect(streams.get(node.id).sessions[0]).toMatchObject({
      role: 'reviewer',
      vendor: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
    });
    expect(threadBodies(node.id).filter((b) => b.startsWith('Model: '))).toEqual([
      'Model: gpt-5.6-sol · medium — balanced (Jev 0.82): well specified and covered by tests; short, low stakes; Codex before Claude',
    ]);
    expect(jev.choiceCalls).toHaveLength(1);
    expect(jev.choiceCalls[0]?.state).toContain('Role: a reviewer');
    // A reviewer's pick is not the node's: `agent.pick` is left alone.
    expect(streams.get(node.id).agent.pick).toBeUndefined();

    // The node's own worker follows the worker order: Claude.
    await attachService.attach(node.id);
    await waitFor(() => streams.get(node.id).agent.status === 'done');
    expect(streams.get(node.id).sessions.at(-1)).toMatchObject({
      role: 'worker',
      vendor: 'claude',
      model: 'claude-sonnet-5-5',
    });
    expect(streams.get(node.id).agent.pick).toMatchObject({
      how: 'jev',
      tier: 'balanced',
      in_tier: { by: 'vendor_order', words: 'Claude before Codex' },
    });
  }, 30_000);

  test('an explicit reviewer pick wins, never asks Jev, and says nothing about the policy', async () => {
    const jev = new FakeClassifier([], { choice: CLEAR });
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS), {
      classifier: jev,
    });
    const node = await nodeIn({
      mode: 'choose',
      presets: MIXED,
      vendor_order_by_role: { reviewer: ['codex'] },
    });
    await attachService.attach(node.id, {
      role: 'reviewer',
      vendor: 'claude',
      model: 'claude-opus-5-5',
    });
    await waitFor(() => threadBodies(node.id).some((b) => b.startsWith('review finished')));
    expect(streams.get(node.id).sessions[0]).toMatchObject({
      role: 'reviewer',
      vendor: 'claude',
      model: 'claude-opus-5-5',
    });
    expect(jev.choiceCalls).toHaveLength(0);
    expect(threadBodies(node.id).filter((b) => b.startsWith('Model: '))).toEqual([]);
  }, 30_000);

  test('under Default a reviewer resolves as before: no Jev call, no line', async () => {
    const jev = new FakeClassifier([], { choice: CLEAR });
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS), {
      classifier: jev,
    });
    const node = await nodeIn({ mode: 'default', presets: [] });
    await attachService.attach(node.id, { role: 'reviewer' });
    await waitFor(() => threadBodies(node.id).some((b) => b.startsWith('review finished')));
    expect(streams.get(node.id).sessions[0]).toMatchObject({ role: 'reviewer', vendor: 'claude' });
    expect(jev.choiceCalls).toHaveLength(0);
    expect(threadBodies(node.id).filter((b) => b.startsWith('Model: '))).toEqual([]);
  }, 30_000);
});

describe('T484: escalation at a start (design/model-routing.md §6, D56)', () => {
  const PRESETS = [
    { vendor: 'claude' as const, model: 'claude-haiku-4-5' },
    { vendor: 'claude' as const, model: 'claude-sonnet-5-5' },
    { vendor: 'claude' as const, model: 'claude-opus-5-5' },
  ];
  const FULL_CONTEXT: FakeAgentScript = {
    steps: [
      { type: 'usage_update', used: 950, size: 1000 },
      { type: 'agent_text', text: 'still reading' },
      { type: 'end_turn' },
    ],
  };
  let events: RoutedEventService;
  /** The provider every start runs, switched between starts. */
  let current: AcpProviderConfig;
  let projects = 0;

  function build(): AttachService {
    events = new RoutedEventService(store);
    const built = new AttachService({
      installedCli: () => undefined,
      store,
      streams,
      home,
      events,
      provider: () => current,
      questions: { listOpen: () => questions.listOpen() },
      gates: { list: () => gates.list() },
    });
    verbs = new VerbService({
      store,
      streams,
      questions,
      escalation: built.routing().escalation,
    });
    return built;
  }

  async function nodeUnder(policy: Record<string, unknown>, repoName?: string): Promise<Stream> {
    projects += 1;
    const project = await new ProjectService(store, streams).create({ name: `Ladder ${projects}` });
    await store.updateProject(project.id, (p) => ({ ...p, model_policy: policy }));
    return streams.create('human', {
      title: 'Parser',
      goal: 'parse the CSV',
      project: project.id,
      ...(repoName !== undefined ? { repo: repoName } : {}),
    });
  }

  const last = (id: string) => streams.get(id).sessions.at(-1);
  const stepLines = (id: string) => threadBodies(id).filter((b) => b.startsWith('Stepped up'));
  const stepped = (id: string) =>
    events
      .activityFor(id)
      .map((a) => a.event)
      .filter((e) => e.type === 'model_escalated');
  const finished = (id: string) => threadBodies(id).filter((b) => b === TURN_FINISHED_LINE).length;

  /** Starts the node's next agent (a message with start) and waits for its turn to finish. */
  async function nextStart(id: string, sessions: number): Promise<void> {
    await attachService.say(id, 'carry on', { start: true });
    await waitFor(
      () => streams.get(id).sessions.length === sessions && streams.get(id).agent.status === 'done',
    );
  }

  test('a failed turn (retries spent) steps up at the next start: the line, the event, the pick', async () => {
    await store.setHomeSessionDefaults({ vendor_failure: { retry: false } });
    current = fakeProviderFor(ACP_PROVIDERS.claude, {
      steps: [{ type: 'agent_text', text: 'Something went wrong' }, { type: 'reject_prompt' }],
    });
    attachService = build();
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS, effort_ceiling: 'high' });
    await attachService.attach(node.id);
    await waitFor(() => streams.get(node.id).escalation?.pending !== undefined);
    expect(last(node.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(streams.get(node.id).escalation?.pending?.trigger).toBe('turn_failed');
    // Recorded, not taken: nothing stepped yet.
    expect(stepLines(node.id)).toEqual([]);

    current = fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS);
    await nextStart(node.id, 2);
    expect(last(node.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    const [line] = stepLines(node.id);
    expect(line?.startsWith('Stepped up to Claude Sonnet 5.5 · high: a turn failed (')).toBe(true);
    expect(line?.endsWith(' on Claude Sonnet 5.5 · medium')).toBe(true);
    expect(streams.get(node.id).agent.pick).toMatchObject({
      how: 'escalation',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      session: last(node.id)?.id,
    });
    // Spent by that start.
    expect(streams.get(node.id).escalation?.pending).toBeUndefined();
    const [event] = stepped(node.id);
    expect(event?.payload).toMatchObject({
      step: 'up',
      trigger: 'turn_failed',
      from: 'Claude Sonnet 5.5 · medium',
      to: 'Claude Sonnet 5.5 · high',
    });
    // Record-only: it woke nobody and waits in no queue.
    expect(events.pendingFor(node.id).some((p) => p.event.type === 'model_escalated')).toBe(false);
  }, 30_000);

  test('the context past 90% without goal_met ends the resting session; the next start is one rung up', async () => {
    current = fakeProviderFor(ACP_PROVIDERS.claude, FULL_CONTEXT);
    attachService = build();
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS, effort_ceiling: 'medium' });
    await attachService.attach(node.id);
    // A model change ends a resting session (T465): the next start is fresh.
    await waitFor(() => last(node.id)?.status === 'stopped');
    expect(last(node.id)?.ended_reason).toContain('its model steps up at the next start');
    expect(streams.get(node.id).escalation?.pending?.trigger).toBe('context_full');

    current = fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS);
    await nextStart(node.id, 2);
    // Sonnet at the ceiling (medium): the next model, at medium.
    expect(last(node.id)).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
    expect(stepLines(node.id)).toEqual([
      'Stepped up to Claude Opus 5.5 · medium: its context passed 90% before the goal was met on Claude Sonnet 5.5 · medium',
    ]);
    // A fresh session with the brief, not a resume of the old one.
    expect(threadBodies(node.id)).not.toContain(RESUMED_LINE);
  }, 30_000);

  test('three quiet turns on a worker (no commit, no progress) step up', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: [] } });
    current = fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS);
    attachService = build();
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS }, 'demo');
    await attachService.attach(node.id);
    await waitFor(() => finished(node.id) === 1);
    expect(streams.get(node.id).escalation?.quiet?.turns).toBe(1);
    await attachService.say(node.id, 'anything?');
    await waitFor(() => finished(node.id) === 2);
    expect(streams.get(node.id).escalation?.pending).toBeUndefined();
    await attachService.say(node.id, 'and now?');
    await waitFor(() => last(node.id)?.status === 'stopped');
    expect(streams.get(node.id).escalation?.pending?.trigger).toBe('quiet_turns');
    await nextStart(node.id, 2);
    expect(last(node.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(stepLines(node.id)).toEqual([
      'Stepped up to Claude Sonnet 5.5 · high: 3 turns passed with no commit and no progress on Claude Sonnet 5.5 · medium',
    ]);
  }, 30_000);

  test('a merge refused twice by the same ship check, with a turn between, steps up', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: [] } });
    current = fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS);
    attachService = build();
    const landing = new DeliveryService({
      store,
      streams,
      diffRules: { check: () => ({ decision: 'deny', reason: 'the tests fail', rule: 'K-1' }) },
      onRefused: (id, key, words) =>
        attachService.routing().escalation.mergeRefused(id, key, words),
    });
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS }, 'demo');
    const first = await attachService.attach(node.id);
    await waitFor(() => finished(node.id) === 1);
    const wt = first.stream.worktree as string;
    writeFileSync(join(wt, 'parser.ts'), 'export const parse = () => [];\n');
    git(['add', 'parser.ts'], wt);
    git(['commit', '-q', '-m', 'parser'], wt);

    expect((await landing.land(node.id)).status).toBe('refused');
    expect(streams.get(node.id).escalation?.refusal).toMatchObject({ key: 'ship:K-1', turns: 0 });
    // Refused again at once, no turn between: not a step.
    await landing.land(node.id);
    expect(streams.get(node.id).escalation?.pending).toBeUndefined();
    // A turn that tried to fix it, then the same refusal.
    await attachService.say(node.id, 'the ship check says the tests fail');
    await waitFor(() => finished(node.id) === 2);
    await landing.land(node.id);
    expect(streams.get(node.id).escalation?.pending).toMatchObject({
      trigger: 'merge_refused',
      reason: 'the merge was refused twice (ship check: the tests fail)',
    });
    await waitFor(() => last(node.id)?.status === 'stopped');
    await nextStart(node.id, 2);
    expect(last(node.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(stepLines(node.id)).toEqual([
      'Stepped up to Claude Sonnet 5.5 · high: the merge was refused twice (ship check: the tests fail) on Claude Sonnet 5.5 · medium',
    ]);
  }, 30_000);

  test('`escalate` mid-turn changes nothing until the turn ends; the verb can’t name a model', async () => {
    const sentinel = join(scratch, `escalate-${ulid()}`);
    current = fakeProviderFor(ACP_PROVIDERS.claude, {
      steps: [
        { type: 'agent_text', text: 'trying the parser again' },
        // The tool call closes the message, so it reaches the thread mid-turn.
        { type: 'tool_call', toolCallId: 'read-1', title: 'read parser.ts' },
        { type: 'wait_for_file', path: sentinel },
        { type: 'end_turn' },
      ],
    });
    attachService = build();
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS });
    await attachService.attach(node.id);
    await waitFor(() => threadBodies(node.id).includes('trying the parser again'));
    const session = last(node.id)?.id as string;
    await expect(
      verbs.escalate({ session, why: 'stuck', model: 'claude-opus-5-5' }),
    ).rejects.toThrow(/escalate/);
    await expect(verbs.escalate({ session, why: 'stuck', effort: 'max' })).rejects.toThrow();
    expect(streams.get(node.id).escalation).toBeUndefined();
    const answer = await verbs.escalate({
      session,
      why: 'the tests still fail and I can’t see why',
    });
    expect(answer.result).toContain('next start');
    expect(threadBodies(node.id)).toContain(
      'asks for a stronger model: the tests still fail and I can’t see why',
    );
    expect(streams.get(node.id).escalation?.pending).toMatchObject({
      trigger: 'asked',
      by: 'agent',
      session,
    });
    // Mid-turn: the session runs on, on its model.
    expect(last(node.id)).toMatchObject({ id: session, status: 'running' });
    writeFileSync(sentinel, '');
    // The turn ends, and so does the session (the model changes).
    await waitFor(() => last(node.id)?.status === 'stopped');
    current = fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS);
    await nextStart(node.id, 2);
    expect(last(node.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(stepLines(node.id)).toEqual([
      'Stepped up to Claude Sonnet 5.5 · high: the agent asked: the tests still fail and I can’t see why on Claude Sonnet 5.5 · medium',
    ]);
  }, 30_000);

  test('Step up ends a resting session, survives a daemon restart, and the next start takes it', async () => {
    current = fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS);
    attachService = build();
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS });
    await attachService.attach(node.id);
    await waitFor(() => isRestingSession(streams.get(node.id), last(node.id) as SessionRef));
    const view = await attachService.routing().stepUp(node.id);
    expect(view.step_up.pending).toMatchObject({ by: 'human', to: 'Claude Sonnet 5.5 · high' });
    await waitFor(() => last(node.id)?.status === 'stopped');

    // A restart: a new attach service (and policy service) over the same home.
    await attachService.stopAll();
    attachService = build();
    await nextStart(node.id, 2);
    expect(last(node.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(stepLines(node.id)).toEqual([
      'Stepped up to Claude Sonnet 5.5 · high: you asked for a stronger model on Claude Sonnet 5.5 · medium',
    ]);
    expect(stepped(node.id).map((e) => e.payload.trigger)).toEqual(['operator']);
    // The step after it: the node runs Sonnet · high now.
    expect(attachService.routing().nodeView(node.id).step_up.next?.words).toBe(
      'Claude Sonnet 5.5 · max',
    );
  }, 30_000);

  test('an explicit pick on the next start wins and clears the pending step (D53)', async () => {
    current = fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS);
    attachService = build();
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS });
    await attachService.attach(node.id);
    await waitFor(() => streams.get(node.id).agent.status === 'done');
    await attachService.routing().stepUp(node.id);
    await attachService.attach(node.id, { model: 'claude-haiku-4-5', effort: 'low' });
    await waitFor(
      () =>
        streams.get(node.id).sessions.length === 2 && streams.get(node.id).agent.status === 'done',
    );
    expect(last(node.id)).toMatchObject({ model: 'claude-haiku-4-5', effort: 'low' });
    expect(streams.get(node.id).escalation?.pending).toBeUndefined();
    expect(streams.get(node.id).agent.pick?.how).toBe('explicit');
    expect(stepLines(node.id)).toEqual([]);
    expect(stepped(node.id)).toEqual([]);
  }, 30_000);

  test('strongest first never steps: a stall goes to Needs me and the session keeps its model', async () => {
    current = fakeProviderFor(ACP_PROVIDERS.claude, FULL_CONTEXT);
    attachService = build();
    const node = await nodeUnder({
      mode: 'choose',
      presets: PRESETS,
      escalation: 'strongest_first',
    });
    await attachService.attach(node.id);
    await waitFor(() => streams.get(node.id).escalation?.stuck !== undefined);
    expect(last(node.id)).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(streams.get(node.id).escalation?.pending).toBeUndefined();
    const inbox = new InboxService({ streams, questions, gates });
    expect(inbox.list().filter((i) => i.kind === 'model_stuck')).toMatchObject([
      {
        stream: node.id,
        context:
          'Parser is stuck on the strongest preset model: its context passed 90% before the goal was met',
      },
    ]);
    // Nothing waits, so the resting session isn't ended: the next line goes to it.
    await waitFor(() => isRestingSession(streams.get(node.id), last(node.id) as SessionRef));
    expect(streams.get(node.id).sessions).toHaveLength(1);
    expect(stepped(node.id).map((e) => e.payload.step)).toEqual(['stuck']);
  }, 30_000);

  test('the top of the ladder: Needs me; an explicit pick then clears the card', async () => {
    current = fakeProviderFor(ACP_PROVIDERS.claude, FULL_CONTEXT);
    attachService = build();
    const node = await nodeUnder({
      mode: 'choose',
      presets: [{ vendor: 'claude', model: 'claude-sonnet-5-5' }],
      effort_ceiling: 'medium',
    });
    await attachService.attach(node.id);
    await waitFor(() => streams.get(node.id).escalation?.stuck !== undefined);
    expect(streams.get(node.id).escalation?.stuck).toMatchObject({
      trigger: 'context_full',
      model: 'Claude Sonnet 5.5 · medium',
    });
    expect(threadBodies(node.id)).toContain(
      'Parser is stuck on the strongest preset model: its context passed 90% before the goal was met',
    );
    const inbox = new InboxService({ streams, questions, gates });
    expect(inbox.list().some((i) => i.kind === 'model_stuck' && i.id === node.id)).toBe(true);
    // The operator picks a stronger model with the chip: the card has done its job.
    current = fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS);
    await attachService.attach(node.id, { model: 'claude-opus-5-5' });
    await waitFor(
      () =>
        streams.get(node.id).sessions.length === 2 && streams.get(node.id).agent.status === 'done',
    );
    expect(streams.get(node.id).escalation?.stuck).toBeUndefined();
    expect(inbox.list().some((i) => i.kind === 'model_stuck')).toBe(false);
  }, 30_000);

  test('an agent, a coordinator or the Director can’t write the escalation record; the daemon can', async () => {
    const node = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const pending = {
      trigger: 'asked' as const,
      reason: 'give me Opus',
      by: 'agent' as const,
      at: new Date().toISOString(),
    };
    for (const principal of ['agent', 'coordinator', 'director', 'human'] as const) {
      await expect(
        store.updateStream(principal, node.id, (s) => ({ ...s, escalation: { pending } })),
      ).rejects.toThrow(/only the daemon may change escalation/);
    }
    expect(streams.get(node.id).escalation).toBeUndefined();
  });
});

describe('T504 (D65): Archive and forget restarts the agent fresh, without the archived threads', () => {
  const log = () => join(scratch, 't504.jsonl');
  const logLines = () =>
    (existsSync(log()) ? readFileSync(log(), 'utf8') : '')
      .split('\n')
      .slice(0, -1)
      .filter((l) => l.trim() !== '');
  const prompts = () => logLines().filter((l) => l.includes('"session/prompt"'));
  const loads = () => logLines().filter((l) => l.includes('"session/load"'));
  const statusOf = (id: string, session: string) =>
    streams.get(id).sessions.find((s) => s.id === session)?.status;

  /** A node whose agent said its line, with a thread on it holding a detail. */
  async function threadedNode(service: AttachService) {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const stream = await service.createNode('human', {
      title: 'CSV parser',
      goal: 'decide the dialect and implement it',
      project: project.id,
      start: false,
    });
    const { session } = await service.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).includes('looking at the parser now'));
    const turn = streams
      .readThread(stream.id, { limit: 500 })
      .entries.find((e) => e.body === 'looking at the parser now');
    const first = await streams.appendThread('human', stream.id, {
      kind: 'line',
      body: 'the secret pepper is 42',
      anchor: { entry: turn?.ts as string },
    });
    return { stream, session, first };
  }

  test('a resting agent ends; a new one starts from a brief without the thread, never session/load', async () => {
    const events = new RoutedEventService(store);
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log() }),
      { deliveryDelayMs: 5, events },
    );
    const { stream, session, first } = await threadedNode(attachService);
    await waitFor(() => statusOf(stream.id, session.id) === 'idle');
    const ops = new ChatThreadOps({
      streams,
      chatThreads: new ChatThreads({ streams, events }),
      events,
      attach: attachService,
    });
    const out = await ops.archive(stream.id, first.ts, { forget: true });
    expect(out.restarted).toBeDefined();
    await waitFor(() => prompts().length === 2);
    expect(loads()).toHaveLength(0);
    const brief = prompts()[1] ?? '';
    expect(brief).toContain('decide the dialect and implement it');
    expect(brief).not.toContain('secret pepper');
    const sessions = streams.get(stream.id).sessions;
    expect(sessions.map((s) => s.status)).toEqual(['stopped', expect.any(String)]);
    expect(sessions[1]?.id).toBe(out.restarted as string);
    // No notice: the new agent never saw the thread.
    expect(events.pendingFor(stream.id).some((p) => p.event.type === 'thread_archived')).toBe(
      false,
    );
    expect(
      readFileSync(join(home, 'sessions', out.restarted as string, 'brief.md'), 'utf8'),
    ).not.toContain('secret pepper');
  }, 30_000);

  test('an ended session is never resumed after it: the next start is fresh', async () => {
    attachService = buildAttachService(
      fakeProviderFor(ACP_PROVIDERS.claude, { ...SPEAKS, logFile: log() }),
      { deliveryDelayMs: 5, sessionIdleMs: 0 },
    );
    const { stream, session, first } = await threadedNode(attachService);
    await waitFor(() => statusOf(stream.id, session.id) === 'stopped');
    // Recorded, with no agent running to restart: the next start must not load the old session.
    await streams.appendThread('human', stream.id, {
      kind: 'event',
      body: 'archived the thread, and restarted the agent without it',
      op: { type: 'archive', thread: first.ts, forget: true },
    });
    await attachService.say(stream.id, 'carry on', { start: true });
    await waitFor(() => prompts().length === 2);
    expect(loads()).toHaveLength(0);
    expect(prompts()[1]).toContain('decide the dialect and implement it');
    expect(prompts()[1]).not.toContain('secret pepper');
  }, 30_000);

  test('it waits while the agent works on a turn: refused, and nothing is recorded', async () => {
    attachService = buildAttachService(fakeProviderFor(ACP_PROVIDERS.claude, SPEAKS_THEN_HANGS));
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const stream = await attachService.createNode('human', {
      title: 'CSV parser',
      goal: 'g',
      project: project.id,
      start: false,
    });
    await attachService.attach(stream.id);
    await waitFor(() => threadBodies(stream.id).includes('looking at the parser now'));
    const turn = streams
      .readThread(stream.id, { limit: 500 })
      .entries.find((e) => e.body === 'looking at the parser now');
    const first = await streams.appendThread('human', stream.id, {
      kind: 'line',
      body: 'x',
      anchor: { entry: turn?.ts as string },
    });
    expect(attachService.agentWorking(stream.id)).toBe(true);
    const ops = new ChatThreadOps({
      streams,
      chatThreads: new ChatThreads({ streams }),
      attach: attachService,
    });
    await expect(ops.archive(stream.id, first.ts, { forget: true })).rejects.toBeInstanceOf(
      AgentWorkingError,
    );
    expect(store.readThread(stream.id).some((e) => e.op !== undefined)).toBe(false);
    await attachService.stop(stream.id);
  }, 30_000);
});

describe("T506: Codex's own PreToolUse gate", () => {
  const codexProvider = (script: FakeAgentScript = SPEAKS) =>
    fakeProviderFor(ACP_PROVIDERS.codex, script);
  const inbox = () => new InboxService({ streams, questions, gates });

  test('a Codex worker gets its hook at the repo root (T511), out of git status; its reviewer the same gate', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    attachService = buildAttachService(codexProvider(SPEAKS_THEN_HANGS));
    const stream = await makeStream('demo');
    const { stream: updated } = await attachService.attach(stream.id, { vendor: 'codex' });
    const worktree = updated.worktree ?? '';
    expect(worktree.startsWith(join(repo, '.worktrees'))).toBe(true);
    // T511: Codex reads a worktree's project hooks from its main repo (§C5 round 4).
    const hooks = join(repo, '.codex', 'hooks.json');
    expect(existsSync(hooks)).toBe(true);
    expect(existsSync(join(worktree, '.codex'))).toBe(false);
    const file = JSON.parse(readFileSync(hooks, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(file.hooks.PreToolUse.map((m) => m.matcher)).toEqual([
      'Bash',
      'apply_patch|Edit|Write',
      'mcp__.*',
    ]);
    const script = file.hooks.PreToolUse[0]?.hooks[0]?.command ?? '';
    expect(script).toBe(join(repo, '.codex', 'agile-pre-tool-use.sh'));
    expect(readFileSync(script, 'utf8')).toContain(
      `hook pre-tool-use --vendor codex --repo ${repo} || exit 2`,
    );
    // Neither the repo nor the worktree shows it.
    expect(git(['status', '--porcelain'], repo)).toBe('');
    expect(git(['status', '--porcelain'], worktree)).not.toContain('.codex');
    const before = readFileSync(hooks, 'utf8');
    await attachService.stop(stream.id);

    // The read-only reviewer in the same worktree: the same file, the same bytes.
    const review = await attachService.attach(stream.id, { role: 'reviewer', vendor: 'codex' });
    expect(review.session.role).toBe('reviewer');
    expect(review.session.worktree).toBe(worktree);
    expect(readFileSync(hooks, 'utf8')).toBe(before);
    await attachService.stop(stream.id);

    // A second Codex node in the repo shares the file: still one set of our matchers.
    const other = await makeStream('demo');
    await attachService.attach(other.id, { vendor: 'codex' });
    expect(readFileSync(hooks, 'utf8')).toBe(before);
    await attachService.stop(other.id);
  }, 30_000);

  test('a Codex node with no repo keeps the hook in its own session dir, every call gated', async () => {
    attachService = buildAttachService(codexProvider(SPEAKS_THEN_HANGS));
    const stream = await makeStream();
    const { session } = await attachService.attach(stream.id, { vendor: 'codex' });
    const cwd = join(home, 'sessions', session.id);
    const script = join(cwd, '.codex', 'agile-pre-tool-use.sh');
    expect(existsSync(join(cwd, '.codex', 'hooks.json'))).toBe(true);
    expect(readFileSync(script, 'utf8')).toContain('hook pre-tool-use --vendor codex || exit 2');
    expect(readFileSync(script, 'utf8')).not.toContain('--repo');
    await attachService.stop(stream.id);
  }, 30_000);

  test('a repo that tracks .codex/hooks.json is refused with a clear message, never changed', async () => {
    mkdirSync(join(repo, '.codex'));
    writeFileSync(join(repo, '.codex', 'hooks.json'), '{"theirs":true}\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'their codex hooks']);
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    attachService = buildAttachService(codexProvider());
    const stream = await makeStream('demo');
    const expected = `${repo} tracks .codex/hooks.json; Codex's gate would change a tracked file`;
    await expect(attachService.attach(stream.id, { vendor: 'codex' })).rejects.toThrow(expected);
    const after = streams.get(stream.id);
    expect(after.agent.status).toBe('blocked');
    expect(after.agent.progress).toContain(expected);
    expect(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8')).toBe('{"theirs":true}\n');
  }, 30_000);

  test('a worktree Codex does not trust is refused, never started ungated; Needs me says how to fix it', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const untrusted = join(scratch, 'codex-untrusted');
    mkdirSync(untrusted, { recursive: true });
    writeFileSync(
      join(untrusted, 'config.toml'),
      '[projects."/somewhere/else"]\ntrust_level = "trusted"\n',
    );
    attachService = buildAttachService(codexProvider(), { codexHome: untrusted });
    const stream = await makeStream('demo');
    const expected = `Codex's gate isn't trusted here: trust ${repo} in Codex`;
    await expect(attachService.attach(stream.id, { vendor: 'codex' })).rejects.toThrow(expected);
    const after = streams.get(stream.id);
    expect(after.sessions.map((s) => s.status)).toEqual(['error']);
    expect(after.sessions[0]?.ended_reason).toContain(expected);
    expect(after.agent.status).toBe('blocked');
    expect(after.agent.progress?.startsWith(`${FAILED_START_PREFIX}${expected}`)).toBe(true);
    // Nothing ran: no hook file was written for a session that never started.
    expect(existsSync(join(repo, '.codex', 'hooks.json'))).toBe(false);
    expect(existsSync(join(after.worktree ?? '', '.codex', 'hooks.json'))).toBe(false);
    const item = inbox()
      .list()
      .find((i) => i.stream === stream.id);
    expect(item?.kind).toBe('blocked');
    expect(item?.context).toContain("Codex's gate isn't trusted here");

    // No Codex config at all reads the same.
    await attachService.stopAll();
    attachService = buildAttachService(codexProvider(), { codexHome: join(scratch, 'no-codex') });
    const other = await makeStream('demo');
    await expect(attachService.attach(other.id, { vendor: 'codex' })).rejects.toThrow(
      "Codex's gate isn't trusted here: trust",
    );
  }, 30_000);

  const RUNS_TWO_COMMANDS: FakeAgentScript = {
    steps: [
      { type: 'agent_text', text: 'running the tests' },
      { type: 'tool_call', toolCallId: 'read-1', kind: 'read', title: 'Read parser.ts' },
      { type: 'tool_call', toolCallId: 'exec-1', kind: 'execute', title: 'Run bun test' },
      { type: 'tool_call', toolCallId: 'edit-1', kind: 'edit', title: 'Editing files' },
      { type: 'hang' },
    ],
  };

  test('tool calls its hook never saw stop the agent and raise Needs me', async () => {
    const sightings = new HookSightings();
    attachService = buildAttachService(codexProvider(RUNS_TWO_COMMANDS), {
      hookSightings: sightings,
      codexGateGraceMs: 50,
    });
    const stream = await makeStream();
    const { session, handle } = await attachService.attach(stream.id, { vendor: 'codex' });
    const info = await handle.exited;
    expect(info.reason).toBe(CODEX_UNGATED_REASON);
    expect(info.ok).toBe(false);
    await waitFor(() => streams.get(stream.id).agent.status === 'blocked');
    const after = streams.get(stream.id);
    expect(after.agent.progress).toBe(`${CRASHED_PREFIX}${CODEX_UNGATED_REASON}`);
    expect(after.sessions.find((s) => s.id === session.id)?.status).toBe('error');
    expect(threadBodies(stream.id)).toContain(`worker stopped: ${CODEX_UNGATED_REASON}`);
    // Not restarted: a restart would run ungated again.
    await Bun.sleep(200);
    expect(streams.get(stream.id).sessions).toHaveLength(1);
    const item = inbox()
      .list()
      .find((i) => i.stream === stream.id);
    expect(item?.kind).toBe('blocked');
    expect(item?.context).toContain('Codex ran a command its gate never saw');
  }, 30_000);

  test('with hook records for its calls, nothing happens', async () => {
    const seen = { count: () => 10, forget: () => {} };
    attachService = buildAttachService(
      codexProvider({
        steps: [
          { type: 'tool_call', toolCallId: 'exec-1', kind: 'execute', title: 'Run bun test' },
          { type: 'tool_call', toolCallId: 'edit-1', kind: 'edit', title: 'Editing files' },
          { type: 'tool_call', toolCallId: 'exec-2', kind: 'execute', title: 'Run ls' },
          { type: 'agent_text', text: 'still here' },
          { type: 'tool_call', toolCallId: 'read-1', kind: 'read', title: 'Read a.ts' },
          { type: 'hang' },
        ],
      }),
      { hookSightings: seen, codexGateGraceMs: 20 },
    );
    const stream = await makeStream();
    const { handle } = await attachService.attach(stream.id, { vendor: 'codex' });
    await waitFor(() => threadBodies(stream.id).some((b) => b.includes('still here')));
    await Bun.sleep(150);
    expect(handle.stopped()).toBe(false);
    expect(streams.get(stream.id).agent.status).toBe('working');
    expect(threadBodies(stream.id).some((b) => b.includes('gate never saw'))).toBe(false);
    await attachService.stop(stream.id);
  }, 30_000);
});
