/**
 * T486: the daemon's own secrets never reach a process it starts for a
 * vendor. A coding agent runs `env` as readily as anything else, and could
 * then echo what it read into a thread, a file or a commit. The TypeSafe
 * classifier key (design §6.1, D16) is the one secret the daemon reads from
 * its environment (`TYPESAFE_API_KEY`); a key kept in `config.yaml` is never
 * in the environment at all.
 *
 * Every vendor spawn builds its env from this: node sessions and the
 * Director (`runner/session.ts`), Refresh models (`runner/model-catalog.ts`),
 * the quick drafts (`streams/titles.ts`) and the CLI updater
 * (`harness/methods.ts`). `HOME`, `PATH` and the vendors' own login
 * variables pass through untouched.
 */

import { TYPESAFE_API_KEY_ENV } from './classifier/jev';

/** Env names the daemon reads for itself and never hands to a child. */
export const DAEMON_ONLY_ENV_NAMES: readonly string[] = Object.freeze([TYPESAFE_API_KEY_ENV]);

/** `env` (the daemon's own by default) without the daemon's secrets. */
export function withoutDaemonSecrets(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !DAEMON_ONLY_ENV_NAMES.includes(name)) out[name] = value;
  }
  return out;
}
