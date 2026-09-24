/**
 * `createFakeSpawn`: the `spawnSession` seam backed by `fake-agent.ts`
 * instead of a real vendor, so a whole daemon's sessions run offline with
 * real worktrees, briefs and registry bookkeeping.
 */

import { join } from 'node:path';
import {
  type SpawnSessionOptions,
  type SpawnedSession,
  spawnSession as defaultSpawnSession,
} from '@agile-agents/acp-client';

const FAKE_AGENT_PATH = join(import.meta.dir, 'fake-agent.ts');

export interface FakeSpawnOptions {
  /**
   * A `FakeAgentScript` JSON file (`AGILE_FAKE_AGENT_SCRIPT`). The default
   * script ends its turn at once, which ends the session; point this at a
   * hanging script to keep one live.
   */
  scriptPath?: string;
}

export function createFakeSpawn(
  options: FakeSpawnOptions = {},
): (opts: SpawnSessionOptions) => SpawnedSession {
  return (opts: SpawnSessionOptions) =>
    defaultSpawnSession({
      ...opts,
      cmd: 'bun',
      args: [FAKE_AGENT_PATH],
      ...(options.scriptPath !== undefined
        ? {
            envOverrides: {
              ...opts.envOverrides,
              AGILE_FAKE_AGENT_SCRIPT: options.scriptPath,
            },
          }
        : {}),
    });
}
