import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, type SpawnSessionOptions, spawnSession } from '@agile-agents/acp-client';
import { validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { GateService } from '../gates';
import { runInit } from '../init';
import { SandboxRequiredError } from '../sandbox';
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

/**
 * Like `fakeSpawn`, but also captures the exact `SpawnSessionOptions`
 * `Runner`/`startAgentSession` built (T031 review round 2 blocker 2 — the
 * `modeId` `Runner.spawn('architect', ...)` actually sends is what proves
 * `RunnerOptions.architectMode` is wired through, not just accepted).
 */
function fakeSpawnCapturing(script: FakeAgentScript, sink: { options?: SpawnSessionOptions }) {
  const scriptPath = join(
    scratch,
    `${Bun.hash(JSON.stringify(script) + Math.random()).toString(36)}.json`,
  );
  writeFileSync(scriptPath, JSON.stringify(script));
  return (opts: SpawnSessionOptions) => {
    sink.options = opts;
    return spawnSession({
      ...opts,
      cmd: 'bun',
      args: [FAKE_AGENT_PATH],
      envOverrides: { ...opts.envOverrides, AGILE_FAKE_AGENT_SCRIPT: scriptPath },
    });
  };
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

  // T031: the architect is a singleton — one bus address regardless of
  // which ticket it's currently focused on (design §15).
  test('architect agent id is the literal singleton "architect", regardless of the ticket', () => {
    expect(agentIdFor('architect', 'TKT-0231')).toBe('architect');
    expect(agentIdFor('architect', 'TKT-9999')).toBe('architect');
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

  // T031: the architect's checkout must not hold `integration`'s own ref —
  // `MergeOwner.onTicketDone` needs its own dedicated worktree on
  // `integration` to merge tickets into (`merge/owner.ts`'s
  // `ensureNamedWorktree`), and a branch-checked-out architect worktree
  // would permanently block every merge the moment it existed (this is
  // exactly the failure the offline e2e reproduced before `ensureArchitect
  // Worktree` switched to `git worktree add --detach`).
  test('spawn(architect, TKT) places a detached checkout of integration at .worktrees/architect, touches no ticket state, and does not block a later merge worktree on integration', async () => {
    const runner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      spawn: fakeSpawn({ steps: [{ type: 'hang' }] }),
    });
    const before = store.getTicket('TKT-0231');

    const result = await runner.spawn('architect', 'TKT-0231');
    expect(result.agentId).toBe('architect');
    expect(result.worktree).toBe(join(repo, '.worktrees', 'architect'));
    expect(existsSync(join(result.worktree, '.claude', 'settings.json'))).toBe(true);

    // No engineer-only side effects leaked onto the ticket the architect
    // happened to be spawned "for" (its brief/ledger context, not a claim
    // on the ticket).
    const after = store.getTicket('TKT-0231');
    expect(after.status).toBe(before.status);
    expect(after.assignee).toBe(before.assignee);
    expect(after.worktree).toBe(before.worktree);

    const agent = store.getAgent('architect');
    expect(agent.role).toBe('architect');
    expect(agent.worktree).toBe(result.worktree);

    // Detached, not branch-checked-out — `git worktree list --porcelain`
    // reports `detached` instead of a `branch` line for this worktree.
    const list = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], {
      cwd: repo,
      stdout: 'pipe',
    }).stdout.toString();
    const architectEntry = list.split('\n\n').find((block) => block.includes(result.worktree));
    expect(architectEntry).toContain('detached');

    // `integration` is still free for a real merge-style dedicated
    // worktree to check out (the branch itself, not detached) — this is
    // exactly what `MergeOwner.onTicketDone` needs and what a
    // branch-checked-out architect worktree would have permanently blocked.
    const mergeWorktree = join(repo, '.worktrees', 'integration-merge-check');
    const mergeCheck = Bun.spawnSync(['git', 'worktree', 'add', mergeWorktree, 'integration'], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(mergeCheck.exitCode).toBe(0);

    runner.stop('architect');
    await result.exited;
  }, 90000);

  // T031 review round 2 (opus blocker 2): `RunnerOptions.architectMode`
  // must actually be reachable from `Runner.spawn`, not just accepted by
  // `startAgentSession` when called directly from a unit test. Proves both
  // halves: the `default` mode id is what's actually sent (not a hard-forced
  // `plan`), and the plan-approval round trip through a real `GateService`
  // still happens regardless of mode — CLAUDE.md's documented fallback
  // ("run `default` mode with a daemon-side `approve_plan` gate") is a real,
  // selectable behaviour, not dead code.
  test('RunnerOptions.architectMode "default" reaches the spawned session (modeId is not forced to "plan") and the approve_plan gate still runs', async () => {
    // `runInit` (this file's `beforeEach`) seeds the repo default
    // `approve_plan: human` — re-point it at `em` so the delegate below
    // actually resolves the gate instead of leaving it pending on a human
    // nobody in this test answers.
    await store.putPolicy({
      gates: {
        approve_plan: 'em',
        approve_decision: 'human',
        sprint_review: 'human',
        unblock: 'human',
        demo: 'human',
      },
      breaker_signals: [],
    });
    const gateService = new GateService(store, {
      delegate: () => ({ decision: 'approve', by: 'em', rationale: 'test delegate' }),
    });
    const resultFile = join(scratch, 'runner-architect-default-mode-plan-result.json');
    const sink: { options?: SpawnSessionOptions } = {};
    const runner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      gateService,
      architectMode: 'default',
      spawn: fakeSpawnCapturing(
        {
          steps: [
            {
              type: 'request_permission',
              toolCall: { toolCallId: 'plan-1', kind: 'switch_mode', title: 'Approve Plan' },
              options: [
                { optionId: 'allow', kind: 'allow_once' },
                { optionId: 'reject', kind: 'reject_once' },
              ],
              resultFile,
            },
            { type: 'end_turn' },
          ],
        },
        sink,
      ),
    });

    const result = await runner.spawn('architect', 'TKT-0231');
    // Claude's own default mode (`ACP_PROVIDERS.claude.defaultModeId`) —
    // never `'plan'` when `architectMode: 'default'` is set. Before this
    // round's fix, `RunnerOptions` had no field to carry this at all, so
    // every `Runner.spawn('architect', ...)` hard-forced `plan` regardless.
    expect(sink.options?.modeId).toBe('default');
    expect(sink.options?.modeId).not.toBe('plan');

    await waitFor(() => existsSync(resultFile));
    const planResult = JSON.parse(readFileSync(resultFile, 'utf8')) as {
      outcome: { outcome: string; optionId?: string };
    };
    // The gate still ran — the fake agent raised the exact same
    // `ExitPlanMode`/"Approve Plan" request a real `plan`-mode session
    // would, and it's still routed through the real `GateService`'s
    // em-delegate rather than falling through to `architectVerdict`'s
    // safe-default deny.
    expect(planResult.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });

    await waitFor(() =>
      store
        .listEvents()
        .some(
          (e) => e.kind === 'hook_decision' && (e.data as { role?: string })?.role === 'architect',
        ),
    );
    const decisionEvent = store
      .listEvents()
      .find(
        (e) => e.kind === 'hook_decision' && (e.data as { role?: string })?.role === 'architect',
      );
    expect((decisionEvent?.data as { decision?: string })?.decision).toBe('allow');

    runner.stop('architect');
    await result.exited;
  }, 90000);

  // T022 round 2 review fix (N1): `ticket.routing.vendor` must actually
  // steer which `AcpProviderConfig` a spawn uses — `fakeSpawn` overrides the
  // real OS-level command regardless of `provider.command` (same seam every
  // other test in this file relies on), so this proves the *selection*,
  // not that a real `pi-acp` process ran (no vendor login in this
  // container — see T022's verify-before-build notes).
  test('a ticket routed to vendor "pi" spawns with ACP_PROVIDERS.pi and installs the agile extension', async () => {
    await store.putTicket(
      {
        ...store.getTicket('TKT-0231'),
        routing: {
          attempts: 0,
          max_attempts: 2,
          escalation: [],
          model: 'claude-sonnet',
          vendor: 'pi',
        },
      },
      { by: 'em' },
    );

    const installCalls: unknown[] = [];
    const runner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      spawn: fakeSpawn({ steps: [{ type: 'hang' }] }),
      piAgentDir: join(scratch, 'pi-agent-dir'),
      installPiExtension: (installOpts) => {
        installCalls.push(installOpts);
        return {
          extensionPath: join(installOpts.agentDir, 'extensions', 'agile.ts'),
          settingsPath: join(installOpts.agentDir, 'settings.json'),
          extensionWritten: true,
          settingsWritten: true,
        };
      },
    });

    const result = await runner.spawn('engineer', 'TKT-0231');
    expect(installCalls).toHaveLength(1);
    expect((installCalls[0] as { agentDir: string }).agentDir).toBe(join(scratch, 'pi-agent-dir'));
    // Real filesystem untouched — the fake `installPiExtension` above never wrote anything.
    expect(existsSync(join(scratch, 'pi-agent-dir'))).toBe(false);

    const agent = store.getAgent('eng-0231');
    expect(agent.vendor).toBe('pi');

    runner.stop('eng-0231');
    await result.exited;
  }, 90000);

  // The injectable override wins outright over `ticket.routing`, per this
  // ticket's own doc comment on `Runner.spawn`.
  test('an explicit provider override wins over ticket.routing', async () => {
    await store.putTicket(
      {
        ...store.getTicket('TKT-0231'),
        routing: {
          attempts: 0,
          max_attempts: 2,
          escalation: [],
          model: 'claude-sonnet',
          vendor: 'pi',
        },
      },
      { by: 'em' },
    );

    const runner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      spawn: fakeSpawn({ steps: [{ type: 'hang' }] }),
    });

    const result = await runner.spawn('engineer', 'TKT-0231', {
      provider: {
        id: 'claude',
        label: 'forced claude',
        command: 'bun',
        args: [],
        envOverrides: {},
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        loadSession: true,
        authMethods: [],
      },
    });

    const agent = store.getAgent('eng-0231');
    expect(agent.vendor).toBe('claude');

    runner.stop('eng-0231');
    await result.exited;
  }, 90000);

  // T021 round 3 (opus review round 2 blockers 1/2): `Runner.isLive` must
  // reflect only the in-process `live` map — never the durable
  // `AgentRecord`, which survives a "restart" (a fresh `Runner` instance
  // over the same store) — and `Runner.promptAgent` must reach the actual
  // still-running subprocess with a genuine second `session/prompt`, not
  // just flip a ticket status. Real subprocess round-trip both times, not
  // mocked.
  test('Runner.isLive reflects only the in-process map (a durable AgentRecord alone is not "live"); Runner.promptAgent delivers a real second turn', async () => {
    const engineerRunner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      spawn: fakeSpawn({ steps: [{ type: 'hang' }] }),
    });
    const eng = await engineerRunner.spawn('engineer', 'TKT-0231');

    const runner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      spawn: fakeSpawn({
        steps: [
          { type: 'tool_call', toolCallId: 'r1', kind: 'other', title: 'review turn' },
          { type: 'end_turn' },
        ],
      }),
    });
    const rev = await runner.spawn('reviewer', 'TKT-0231');

    expect(runner.isLive('reviewer-0231')).toBe(true);

    // A "restart" is just a fresh `Runner` over the same durable store —
    // the `AgentRecord` the spawn above wrote is still on disk, but this
    // new instance's own `live` map starts empty.
    const restarted = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      spawn: fakeSpawn({ steps: [{ type: 'hang' }] }),
    });
    // `store.putAgent` is fire-and-forget from `startAgentSession` (never
    // awaited by `spawn()`'s own return) — wait for it to actually land
    // before asserting the record survives a "restart".
    await waitFor(() => agentExists('reviewer-0231'));
    expect(restarted.isLive('reviewer-0231')).toBe(false); // but this process never spawned it

    const toolCallCount = () =>
      store
        .listEvents()
        .filter(
          (e) => e.kind === 'tool_call' && (e.data as Record<string, unknown>).toolCallId === 'r1',
        ).length;
    await waitFor(() => toolCallCount() >= 1, { timeoutMs: 60_000 }); // round 1's own spawn-time prompt.

    await runner.promptAgent('reviewer-0231', 're-review: please check again');
    await waitFor(() => toolCallCount() >= 2, { timeoutMs: 60_000 }); // a genuine second turn on the SAME subprocess.

    runner.stop('reviewer-0231');
    await rev.exited;
    engineerRunner.stop('eng-0231');
    await eng.exited;
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
    // `pid` is optional on `AgentRecord` (review round 3) precisely so a
    // real spawn's pid is never allowed to be *missing and silently
    // defaulted* — but a real spawn always DOES get one, so this is a real
    // assertion, not a type-narrowing formality: the crash-recovery
    // acceptance step below needs a real pid to kill.
    expect(recordedPid).toBeDefined();
    expect(recordedPid).toBe(realPid);
    expect(recordedPid).not.toBe(process.pid);

    process.kill(recordedPid as number, 'SIGKILL');

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

describe('Runner.spawn — provider-level requiresSandbox cannot be opted out of by vendors.yaml (T027 review round 1 B2)', () => {
  test('a bare `grok` vendors.yaml stanza (no requires_sandbox key) + no sandbox backend refuses the engineer spawn before any ticket transition', async () => {
    // The exact shape design §8's own example yaml uses — accounts only,
    // no `requires_sandbox` key anywhere. `VendorConfigSchema` defaults
    // that field to `false`, so this is the case that would run Grok
    // engineer's ungated exec completely unsandboxed if the flag lived
    // only in vendors.yaml.
    await store.putVendors({ grok: { accounts: [{ id: 'default', auth: 'subscription' }] } });
    const before = store.getTicket('TKT-0231');

    const runner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      provider: ACP_PROVIDERS.grok,
      // Stands in for a host with no tier-0 backend (`detectBackend()` ->
      // `'none'`) — same fail-closed contract `sandbox/wrap.ts`'s own
      // tests exercise directly; this test's job is only to prove
      // `Runner.spawn` actually calls it with `requiresSandbox: true` for
      // a plain `grok` stanza, not to re-verify `wrapAgentCommand`'s own
      // backend-detection logic.
      wrapCommand: (input) => {
        if (input.requiresSandbox) {
          throw new SandboxRequiredError(input.vendor, input.role, 'none');
        }
        return { command: input.command, args: [...input.args], envOverrides: {}, backend: 'none' };
      },
    });

    await expect(runner.spawn('engineer', 'TKT-0231')).rejects.toThrow(SandboxRequiredError);

    const after = store.getTicket('TKT-0231');
    expect(after.status).toBe(before.status);
    expect(after.assignee).toBe(before.assignee);
    expect(after.worktree).toBe(before.worktree);
    expect(agentExists('eng-0231')).toBe(false);
  });

  test('the same bare `grok` stanza with a wrapCommand stand-in for a live backend spawns normally (requiresSandbox alone does not block a sandboxed host)', async () => {
    await store.putVendors({ grok: { accounts: [{ id: 'default', auth: 'subscription' }] } });

    const runner = trackedRunner({
      store,
      bus,
      repoRoot: repo,
      provider: ACP_PROVIDERS.grok,
      spawn: fakeSpawn({ steps: [{ type: 'hang' }] }),
      wrapCommand: (input) => ({
        command: input.command,
        args: [...input.args],
        envOverrides: {},
        backend: 'none',
      }),
    });

    const result = await runner.spawn('engineer', 'TKT-0231');
    expect(result.agentId).toBe('eng-0231');
    expect(store.getTicket('TKT-0231').status).toBe('in_progress');
  }, 90000);
});
