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
  GateService,
  type RpcServerHandle,
  StateStore,
  buildBusRpcMethods,
  buildGateRpcMethods,
  buildHaltRpcMethods,
  buildOracleRpcMethods,
  buildStateRpcMethods,
  runInit,
  startRpcServer,
} from '@agile-agents/daemon';

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
  cleanup(): Promise<void>;
}

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
    },
  });

  return {
    repo,
    stateRoot: init.stateRoot,
    socketPath,
    store,
    rpc,
    gateService,
    async cleanup() {
      await rpc.close();
      rmSync(repo, { recursive: true, force: true });
    },
  };
}
