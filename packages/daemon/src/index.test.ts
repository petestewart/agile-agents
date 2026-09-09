import { expect, test } from 'bun:test';
import { PACKAGE_NAME } from './index';

test('PACKAGE_NAME identifies the package', () => {
  expect(PACKAGE_NAME).toBe('@agile-agents/daemon');
});

// Behavioural coverage lives in config.test.ts, lock.test.ts, rpc.test.ts,
// http.test.ts, daemon.test.ts, and init.test.ts — this file just checks the
// public surface re-exports without throwing.
test('re-exports the public daemon API', async () => {
  const mod = await import('./index');
  expect(typeof mod.discoverConfig).toBe('function');
  expect(typeof mod.acquireLock).toBe('function');
  expect(typeof mod.startRpcServer).toBe('function');
  expect(typeof mod.startHttpServer).toBe('function');
  expect(typeof mod.startDaemon).toBe('function');
  expect(typeof mod.installShutdownSignals).toBe('function');
  expect(typeof mod.runInit).toBe('function');
  expect(mod.STATE_BRANCH).toBe('agile-state');
});
