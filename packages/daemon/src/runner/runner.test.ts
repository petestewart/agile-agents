import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SpawnSessionOptions, spawnSession } from '@agile-agents/acp-client';
import { validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { StateStore } from '../store';
import type { FakeAgentScript } from './fake-agent';
import { buildRunnerRpcMethods } from './rpc';
import { Runner, agentIdFor } from './runner';

const FAKE_AGENT_PATH = join(import.meta.dir, 'fake-agent.ts');

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;
let scratch: string;
// T012 QA round fix: every `Runner` a test builds is torn down in
// `afterEach` regardless of whether the test's own body got that far — a
// leaked `bun fake-agent.ts` subprocess (from a test failing mid-assertion,
// before its own `runner.stop(...)` line) was the reproduced root cause of
// a real full-suite slowdown; see the pipeline report.
let activeRunners: Runner[] = [];

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

/** A `spawnSession` stand-in that always launches `fake-agent.ts`, scripted per call. */
function fakeSpawn(script: FakeAgentScript, pidFile?: string) {
  const scriptPath = join(
    scratch,
    `${Bun.hash(JSON.stringify(script) + Math.random()).toString(36)}.json`,
  );
  writeFileSync(scriptPath, JSON.stringify(script));
  return (opts: SpawnSessionOptions) =>
    spawnSession({
      ...opts,
      cmd: 'bun',
      args: [FAKE_AGENT_PATH],
      envOverrides: {
        ...opts.envOverrides,
        AGILE_FAKE_AGENT_SCRIPT: scriptPath,
        ...(pidFile ? { AGILE_FAKE_AGENT_PIDFILE: pidFile } : {}),
      },
    });
}

/** Builds a `Runner` and registers it for forced teardown in `afterEach` — see `activeRunners`. */
function trackedRunner(opts: ConstructorParameters<typeof Runner>[0]): Runner {
  const runner = new Runner(opts);
  activeRunners.push(runner);
  return runner;
}

/**
 * Polls a real, checkable condition instead of a blind `Bun.sleep(N)` — the
 * event-driven alternative the QA round asked for wherever there's no
 * cheaper synchronous signal to await directly. Still bounded, so a
 * genuinely broken condition fails fast-ish rather than hanging to the
 * outer test timeout.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 20_000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await Bun.sleep(intervalMs);
  }
}

function agentExists(id: string): boolean {
  try {
    store.getAgent(id as never);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-runner-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  bus = new Bus(store, stateRoot);
  scratch = mkdtempSync(join(tmpdir(), 'agile-runner-scratch-'));
  activeRunners = [];

  await store.putTicket(
    validateTicket({
      id: 'TKT-0231',
      title: 'Agent runner and worktree manager',
      status: 'assigned',
      contract: {},
      history: [],
    }),
    { by: 'em' },
  );
});

afterEach(async () => {
  // Force-stop every runner's sweep timer and every live session, then wait
  // (bounded) for each session's own exit/crash cleanup to actually finish
  // — regardless of what the test body itself did — before the repo is
  // removed, so a still-in-flight commit can never race the `rmSync` below.
  await Promise.all(
    activeRunners.map(async (runner) => {
      const live = runner.list();
      runner.stopAll();
      await Promise.all(live.map((r) => Promise.race([r.exited, Bun.sleep(15_000)])));
    }),
  );
  await store.flush();
  store.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe('Runner.spawn', () => {
  test('agent id scheme is <rolePrefix>-<ticket digits>', () => {
    expect(agentIdFor('engineer', 'TKT-0231')).toBe('eng-0231');
    expect(agentIdFor('reviewer', 'TKT-0231')).toBe('reviewer-0231');
    expect(agentIdFor('qa', 'TKT-0231')).toBe('qa-0231');
  });

  // Timeout justification: 90s bounds one real `bun <fake-agent.ts>` spawn
  // plus registration and the final teardown wait, with generous headroom
  // for this sandbox's measured worst-case subprocess-start latency under
  // full-suite CPU contention (a clean, idle run finishes in ~1-2s).
  test('spawn(engineer, TKT) places the worktree, transitions the ticket, writes hook settings, and registers the agent', async () => {
    const runner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      spawn: fakeSpawn({ steps: [{ type: 'hang' }] }),
    });

    const result = await runner.spawn('engineer', 'TKT-0231');
    expect(result.agentId).toBe('eng-0231');
    expect(result.worktree).toBe(join(repo, '.worktrees', 'TKT-0231'));
    expect(existsSync(join(result.worktree, '.claude', 'settings.json'))).toBe(true);

    const ticket = store.getTicket('TKT-0231');
    expect(ticket.status).toBe('in_progress');
    expect(ticket.assignee).toBe('eng-0231');
    expect(ticket.worktree).toBe('.worktrees/TKT-0231');

    const agent = store.getAgent('eng-0231');
    expect(agent.role).toBe('engineer');
    expect(agent.worktree).toBe(result.worktree);
    // T012 QA round fix: the recorded pid is the fake agent's own OS pid.
    expect(agent.pid).not.toBe(process.pid);

    expect(runner.list().map((r) => r.agentId)).toEqual(['eng-0231']);

    runner.stop('eng-0231');
    await result.exited;
  }, 90000);

  // T012 QA round finding: a ticket created `ready` (not pre-`assigned`)
  // must still advance all the way to `in_progress` — the design's
  // assignment path, `TICKET_TRANSITIONS`: `ready -> assigned ->
  // in_progress` (no direct edge skips `assigned`).
  test('spawn(engineer, TKT) on a `ready` ticket advances ready -> assigned -> in_progress, setting assignee/worktree', async () => {
    await store.transitionTicket('TKT-0231', 'ready', { by: 'test' });
    // (fixture ticket starts `assigned`, per `beforeEach` — walk it back to
    // `ready` first since `assigned -> ready` is itself a legal edge.)
    expect(store.getTicket('TKT-0231').status).toBe('ready');

    const runner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      spawn: fakeSpawn({ steps: [{ type: 'hang' }] }),
    });
    const result = await runner.spawn('engineer', 'TKT-0231');

    const ticket = store.getTicket('TKT-0231');
    expect(ticket.status).toBe('in_progress');
    expect(ticket.assignee).toBe('eng-0231');
    expect(ticket.worktree).toBe('.worktrees/TKT-0231');
    // Both edges actually happened (not skipped) — visible in history.
    expect(ticket.history.some((h) => h.includes('ready') && h.includes('assigned'))).toBe(true);
    expect(ticket.history.some((h) => h.includes('assigned') && h.includes('in_progress'))).toBe(
      true,
    );

    runner.stop('eng-0231');
    await result.exited;
  }, 90000);

  // Consolidated (review fix — subprocess-heavy tests measurably slow the
  // full 76-file suite under this sandbox's CPU ceiling; see the pipeline
  // report): one `Runner`, three roles spawned in turn, instead of three
  // separate real-subprocess tests.
  test('reviewer reuses the engineer worktree (refusing before one exists); QA gets its own fresh clone', async () => {
    const runner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      spawn: fakeSpawn({ steps: [{ type: 'hang' }] }),
    });

    await expect(runner.spawn('reviewer', 'TKT-0231')).rejects.toThrow();

    const eng = await runner.spawn('engineer', 'TKT-0231');
    const rev = await runner.spawn('reviewer', 'TKT-0231');
    expect(rev.worktree).toBe(eng.worktree);

    const qa = await runner.spawn('qa', 'TKT-0231');
    expect(qa.worktree).not.toBe(eng.worktree);
    expect(qa.worktree).toBe(join(repo, '.worktrees', 'TKT-0231-qa'));

    runner.stop('eng-0231');
    runner.stop('reviewer-0231');
    runner.stop('qa-0231');
    await Promise.all([eng.exited, rev.exited, qa.exited]);
  }, 90000);
});

describe('crash recovery', () => {
  test('kill -9 on the *recorded* pid (AgentRecord.pid) readies the ticket, escalates to em, keeps the worktree, and drops the agent record — within one liveness interval', async () => {
    const pidFile = join(scratch, 'agent.pid');
    const runner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      spawn: fakeSpawn({ steps: [{ type: 'usage_update', used: 5 }, { type: 'hang' }] }, pidFile),
      // Short sweep so the backstop liveness path (not just session.ts's own
      // `exit` handler) would also catch this quickly if it ever needed to.
      sweepIntervalMs: 50,
    });

    const result = await runner.spawn('engineer', 'TKT-0231');
    expect(store.getTicket('TKT-0231').status).toBe('in_progress');

    // Wait for the fake agent to actually start and record its own pid.
    await waitFor(() => existsSync(pidFile));
    const realPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(realPid).toBeGreaterThan(0);

    // Wait for registration, then use the pid *on the durable record* —
    // the literal acceptance step ("kill -9 the agent process" via its
    // recorded pid) and the T012 QA round's critical finding that this must
    // actually be the agent's own pid, not the daemon's/test's.
    await waitFor(() => agentExists('eng-0231'));
    const recordedPid = store.getAgent('eng-0231' as never).pid;
    expect(recordedPid).toBe(realPid);
    expect(recordedPid).not.toBe(process.pid);

    process.kill(recordedPid, 'SIGKILL');

    // `session.ts`'s own `exit` handler drives this — no need to wait a full
    // liveness timeout; `result.exited` resolves once cleanup has run.
    const info = await result.exited;
    expect(info.ticketReadied).toBe(true);

    expect(store.getTicket('TKT-0231').status).toBe('ready');
    expect(existsSync(result.worktree)).toBe(true);
    expect(() => store.getAgent('eng-0231')).toThrow();

    const inbox = bus.poll('em');
    expect(inbox.some((m) => m.kind === 'escalate' && m.ticket === 'TKT-0231')).toBe(true);
  }, 90_000);
});

describe('runSweep', () => {
  test('drives bus.checkLiveness and bus.sweepRedelivery', async () => {
    let livenessCalls = 0;
    let redeliveryCalls = 0;
    const runner = trackedRunner({ store, bus, repoRoot: repo });
    const originalLiveness = bus.checkLiveness.bind(bus);
    const originalRedelivery = bus.sweepRedelivery.bind(bus);
    bus.checkLiveness = (...args: Parameters<Bus['checkLiveness']>) => {
      livenessCalls += 1;
      return originalLiveness(...args);
    };
    bus.sweepRedelivery = (...args: Parameters<Bus['sweepRedelivery']>) => {
      redeliveryCalls += 1;
      return originalRedelivery(...args);
    };

    await runner.runSweep();
    expect(livenessCalls).toBe(1);
    expect(redeliveryCalls).toBe(1);
  });
});

describe('runner.* RPC methods', () => {
  test('spawn/list/stop round-trip', async () => {
    const runner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      spawn: fakeSpawn({ steps: [{ type: 'hang' }] }),
    });
    const methods = buildRunnerRpcMethods(runner);

    const spawned = (await methods['runner.spawn']?.({ role: 'engineer', ticket: 'TKT-0231' })) as {
      agentId: string;
    };
    expect(spawned.agentId).toBe('eng-0231');

    const listed = (await methods['runner.list']?.({})) as Array<{ agentId: string }>;
    expect(listed.map((r) => r.agentId)).toEqual(['eng-0231']);

    const stopped = (await methods['runner.stop']?.({ agentId: 'eng-0231' })) as {
      stopped: boolean;
    };
    expect(stopped.stopped).toBe(true);

    await expect(
      Promise.resolve(methods['runner.spawn']?.({ role: 'bogus', ticket: 'TKT-0231' })),
    ).rejects.toThrow();

    // `runner.stop` (like `Runner.stop`) only starts the underlying
    // process's teardown — wait (event-driven: polls the real `list()`
    // state, not a blind sleep) for the session's own exit/crash handling
    // to actually finish before the test ends, so `afterEach`'s `rmSync`
    // never races a still-in-flight commit from `finish()`.
    await waitFor(async () => {
      const remaining = (await methods['runner.list']?.({})) as Array<{ agentId: string }>;
      return remaining.length === 0;
    });
    expect((await methods['runner.list']?.({})) as Array<{ agentId: string }>).toEqual([]);
  }, 90000);
});
