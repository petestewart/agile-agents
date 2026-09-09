/**
 * `agile daemon start` — start `agiled` in the foreground for this repo
 * (T004). Unchanged behaviour from T004; moved here so `index.ts` is pure
 * dispatch.
 */

import { installShutdownSignals, startDaemon } from '@agile-agents/daemon';

export async function runCliDaemonStart(cwd: string = process.cwd()): Promise<string> {
  const handle = await startDaemon({ cwd });
  installShutdownSignals(handle);
  return (
    `agiled started: pid=${handle.lock.pid} ` +
    `http=http://127.0.0.1:${handle.http.port} socket=${handle.rpc.socketPath} ` +
    `state=${handle.config.stateRoot}`
  );
}
