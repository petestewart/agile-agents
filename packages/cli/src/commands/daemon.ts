/**
 * `agile daemon start` — start `agiled` in the foreground for this repo
 * (T004). Unchanged behaviour from T004; moved here so `index.ts` is pure
 * dispatch.
 */

import { join } from 'node:path';
import {
  createEmSessionDelegate,
  discoverConfig,
  installShutdownSignals,
  startDaemon,
} from '@agile-agents/daemon';

export async function runCliDaemonStart(cwd: string = process.cwd()): Promise<string> {
  // em-owned gates (`unblock` from the hook, `approve_plan`, ...) are decided
  // by a one-shot EM vendor session (`em/delegate.ts`) — without a delegate
  // `GateService` fails closed and every such request parks as pending.
  const handle = await startDaemon({
    cwd,
    gateDelegate: createEmSessionDelegate({
      stateRoot: discoverConfig({ cwd }).stateRoot,
      cwd,
      onNotice: (line) => console.error(line),
      stderrLogDir: join(cwd, '.agile-daemon-cache', 'sessions'),
    }),
  });
  installShutdownSignals(handle);
  return (
    `agiled started: pid=${handle.lock.pid} ` +
    `http=http://127.0.0.1:${handle.http.port} socket=${handle.rpc.socketPath} ` +
    `state=${handle.config.stateRoot}`
  );
}
