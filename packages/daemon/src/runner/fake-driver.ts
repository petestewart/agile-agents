/**
 * `createFakeSpawn` — the `Runner`/`startAgentSession` `spawn` seam
 * (`AgentSessionOptions['spawn']`), backed by this package's own
 * `fake-agent.ts` test double instead of a real vendor ACP process.
 *
 * T012's own tests already spawn `fake-agent.ts` as a real subprocess per
 * test (`runner/session.test.ts`'s `fakeProvider`); this is the same
 * subprocess, just wired as the `Runner`-level `spawn` override so a whole
 * daemon (`startDaemon({ runnerSpawn: createFakeSpawn() })`) can run every
 * engineer/reviewer/qa session against it — `agile run`'s offline/no-login
 * demo mode (T021), which has no scripted per-tool-call behaviour to
 * inject here (the demo driver does its actual work through direct daemon-
 * side calls — `board_post`/`review_submit`/qa verbs — not by scripting
 * this transport), so the default `fake-agent.ts` script (one
 * `usage_update` + `end_turn`) is enough: real worktree placement, brief
 * assembly, and agent-registry bookkeeping, with no live vendor and no
 * per-call script to maintain.
 */

import { join } from 'node:path';
import {
  type SpawnSessionOptions,
  type SpawnedSession,
  spawnSession as defaultSpawnSession,
} from '@agile-agents/acp-client';

const FAKE_AGENT_PATH = join(import.meta.dir, 'fake-agent.ts');

export function createFakeSpawn(): (opts: SpawnSessionOptions) => SpawnedSession {
  return (opts: SpawnSessionOptions) =>
    defaultSpawnSession({
      ...opts,
      cmd: 'bun',
      args: [FAKE_AGENT_PATH],
    });
}
