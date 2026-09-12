/**
 * Test-only helper: spins up a real in-process daemon RPC server (same
 * wiring as `packages/daemon/src/daemon.ts`'s `startDaemon`, built from
 * public `@agile-agents/daemon` exports only) against a freshly `agile
 * init`-ed temp repo. Used by every command test in `commands/*.test.ts`
 * that needs a live socket to round-trip against, per the ticket's
 * validation step ("CLI tests against an in-process daemon").
 *
 * Not `startDaemon` itself: that also binds an HTTP server and acquires the
 * repo lock, neither of which any CLI test needs, and binding two extra
 * listeners per test would slow the suite for no coverage gained.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Bus,
  FakeRunner,
  GateService,
  type JiraClient,
  JiraSync,
  type RpcServerHandle,
  StateStore,
  ToolService,
  buildBusRpcMethods,
  buildGateRpcMethods,
  buildHaltRpcMethods,
  buildOracleRpcMethods,
  buildStateRpcMethods,
  buildSyncRpcMethods,
  buildToolRpcMethods,
  loadToolRegistry,
  runInit,
  startRpcServer,
} from '@agile-agents/daemon';
import { RpcConnectionError, callRpc } from './client';

export interface TestDaemon {
  repo: string;
  stateRoot: string;
  socketPath: string;
  store: StateStore;
  rpc: RpcServerHandle;
  /** Same instance wired into `gate.*` RPC methods — tests use this to seed
   * a pending `HilRequest` the way `packages/daemon/src/gates/rpc.test.ts`
   * does, since there is no `gate.request` RPC for an external client to
   * create one through. */
  gateService: GateService;
  /** Same instance wired into `sync.*` RPC — `agile sync jira link|unlink|status`
   * round-trips against it. Its Jira client is inert (see `INERT_JIRA_CLIENT`):
   * link/unlink/status are pure local state, so no test needs a fake server. */
  jiraSync: JiraSync;
  cleanup(): Promise<void>;
}

/**
 * `link`/`unlink`/`status` never call Jira — they read and write the
 * host-local `agile.config.yaml` and the store. Only `tick()` talks to a
 * server, and no CLI verb ticks. Throwing here keeps that true: a future verb
 * that does reach Jira fails loudly in tests rather than silently hitting the
 * network.
 */
const INERT_JIRA_CLIENT: JiraClient = {
  searchUpdatedSince() {
    throw new Error('test daemon: no Jira server is configured');
  },
  updateIssue() {
    throw new Error('test daemon: no Jira server is configured');
  },
  transitionIssue() {
    throw new Error('test daemon: no Jira server is configured');
  },
};

export async function startTestDaemon(prefix = 'agile-cli-test-'): Promise<TestDaemon> {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });

  const init = runInit(repo);
  const store = StateStore.open(init.stateRoot);
  const socketPath = join(repo, '.agile-daemon.sock');

  // A no-op delegate (never auto-approves) matches production's default —
  // tests that need auto-delegation pass their own `GateService` instead of
  // using this helper.
  const gateService = new GateService(store);
  // `FakeRunner` (never a real vendor session) so `tool.*` tests never need
  // `AGILE_LIVE=1` — same reasoning as the daemon's own tool tests.
  const toolService = new ToolService({
    store,
    bus: new Bus(store, init.stateRoot),
    registry: loadToolRegistry(init.stateRoot),
    runner: new FakeRunner(),
    repoRoot: repo,
  });

  const jiraSync = new JiraSync({
    store,
    client: INERT_JIRA_CLIENT,
    configPath: join(repo, 'agile.config.yaml'),
    onError: () => {},
  });

  const rpc = startRpcServer({
    socketPath,
    version: 'test',
    stateRoot: init.stateRoot,
    startedAt: Date.now(),
    extraMethods: {
      ...buildStateRpcMethods(store),
      ...buildBusRpcMethods(new Bus(store, init.stateRoot)),
      ...buildOracleRpcMethods(store),
      ...buildHaltRpcMethods(store),
      ...buildGateRpcMethods(gateService),
      ...buildToolRpcMethods(toolService),
      ...buildSyncRpcMethods(jiraSync),
    },
  });
  await rpc.listening;
  // `listening` says the server bound its path; a client still saw
  // `connect ENOENT` on it once on a loaded CI runner (the `mcp --socket`
  // bridge test, 2026-09-11, twin run green, no local reproduction in 8
  // runs under load). Prove the socket connectable from this process before
  // handing it to a test that spawns a real CLI subprocess against it.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await callRpc(socketPath, 'daemon.ping', {}, { timeoutMs: 1000 });
      break;
    } catch (err) {
      if (!(err instanceof RpcConnectionError) || Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  return {
    repo,
    stateRoot: init.stateRoot,
    socketPath,
    store,
    rpc,
    gateService,
    jiraSync,
    async cleanup() {
      await rpc.close();
      rmSync(repo, { recursive: true, force: true });
    },
  };
}
