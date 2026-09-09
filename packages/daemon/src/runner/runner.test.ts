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
import { agentIdFor } from './runner';
import { Runner } from './runner';

const FAKE_AGENT_PATH = join(import.meta.dir, 'fake-agent.ts');

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;
let scratch: string;

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
  // Drain any pending deferred-commit writes (heartbeat/ledger/tool_call
  // events — see store.ts's "Deferred-commit batching" header) before the
  // repo is deleted; otherwise the background flush timer can fire a `git`
  // command against a directory that no longer exists.
  await store.flush();
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe('Runner.spawn', () => {
  test('agent id scheme is <rolePrefix>-<ticket digits>', () => {
    expect(agentIdFor('engineer', 'TKT-0231')).toBe('eng-0231');
    expect(agentIdFor('reviewer', 'TKT-0231')).toBe('reviewer-0231');
    expect(agentIdFor('qa', 'TKT-0231')).toBe('qa-0231');
  });

  test('spawn(engineer, TKT) places the worktree, transitions the ticket, writes hook settings, and registers the agent', async () => {
    const runner = new Runner({
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

    expect(runner.list().map((r) => r.agentId)).toEqual(['eng-0231']);

    runner.stop('eng-0231');
    await result.exited;
  }, 90000);

  // Consolidated (review fix — subprocess-heavy tests measurably slow the
  // full 76-file suite under this sandbox's CPU ceiling; see the pipeline
  // report): one `Runner`, three roles spawned in turn, instead of three
  // separate real-subprocess tests.
  test('reviewer reuses the engineer worktree (refusing before one exists); QA gets its own fresh clone', async () => {
    const runner = new Runner({
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
  test('kill -9 on the agent process readies the ticket, escalates to em, keeps the worktree, and drops the agent record — within one liveness interval', async () => {
    const pidFile = join(scratch, 'agent.pid');
    const runner = new Runner({
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
    for (let i = 0; i < 500 && !existsSync(pidFile); i++) {
      await Bun.sleep(20);
    }
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);

    process.kill(pid, 'SIGKILL');

    // `session.ts`'s own `exit` handler drives this — no need to wait a full
    // liveness timeout; `result.exited` resolves once cleanup has run.
    const info = await result.exited;
    expect(info.ticketReadied).toBe(true);

    expect(store.getTicket('TKT-0231').status).toBe('ready');
    expect(existsSync(result.worktree)).toBe(true);
    expect(() => store.getAgent('eng-0231')).toThrow();

    const inbox = bus.poll('em');
    expect(inbox.some((m) => m.kind === 'escalate' && m.ticket === 'TKT-0231')).toBe(true);

    runner.stopAll();
  }, 90_000);
});

describe('runSweep', () => {
  test('drives bus.checkLiveness and bus.sweepRedelivery', async () => {
    let livenessCalls = 0;
    let redeliveryCalls = 0;
    const runner = new Runner({ store, bus, repoRoot: repo });
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
    const runner = new Runner({
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
    // process's teardown — wait for the session's own exit/crash handling
    // to actually finish (surfaced here as it dropping out of `list()`)
    // before the test ends, so `afterEach`'s `rmSync` never races a
    // still-in-flight commit from `finish()`.
    for (let i = 0; i < 500; i++) {
      const remaining = (await methods['runner.list']?.({})) as Array<{ agentId: string }>;
      if (remaining.length === 0) break;
      await Bun.sleep(20);
    }
    expect((await methods['runner.list']?.({})) as Array<{ agentId: string }>).toEqual([]);
  }, 90000);
});
