/**
 * T343: the git env a read-only session is spawned with. The hook lets a
 * reviewer run only `git diff`/`log`/`show`/`status`, but repo-local settings
 * can still make those run a program: a `.gitattributes` `diff=<name>` with
 * `diff.<name>.textconv`/`.command` (or `filter=<name>` with a clean filter),
 * `diff.external`, `core.fsmonitor` on `status`, a `gpg.*program` on a signed
 * commit (`log.showSignature`, `%G?`), or a pager. These env vars neutralise
 * them (checked against git 2.43), and the hook's allowlist refuses `VAR=`, `env`, `unset` and
 * `export`, so the agent cannot take them off again.
 */

import type { PermissionRole } from './types';

/** Git's well-known empty tree: attributes are read from it, so no `diff=` binding applies. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Config forced through `GIT_CONFIG_KEY_n`, applied after every config file. */
const READ_ONLY_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['diff.external', ''],
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.pager', 'cat'],
  ['gpg.program', 'false'],
  ['gpg.openpgp.program', 'false'],
  ['gpg.x509.program', 'false'],
  ['gpg.ssh.program', 'false'],
];

/**
 * The env overrides a session of `role` gets: `{}` for the engineer, the
 * read-only git env otherwise. `base` is the env the session would get
 * without these; its `GIT_CONFIG_COUNT` entries are re-emitted and ours
 * appended after them (a later entry wins), so neither side is clobbered.
 */
export function readOnlyGitEnv(
  role: PermissionRole,
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (role === 'engineer') return {};
  const raw = base.GIT_CONFIG_COUNT;
  const existing = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
  const env: Record<string, string> = {
    GIT_ATTR_SOURCE: EMPTY_TREE_SHA,
    GIT_PAGER: 'cat',
  };
  for (let i = 0; i < existing; i++) {
    const key = base[`GIT_CONFIG_KEY_${i}`];
    const value = base[`GIT_CONFIG_VALUE_${i}`];
    if (key !== undefined) env[`GIT_CONFIG_KEY_${i}`] = key;
    if (value !== undefined) env[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  for (const [n, [key, value]] of READ_ONLY_GIT_CONFIG.entries()) {
    env[`GIT_CONFIG_KEY_${existing + n}`] = key;
    env[`GIT_CONFIG_VALUE_${existing + n}`] = value;
  }
  env.GIT_CONFIG_COUNT = String(existing + READ_ONLY_GIT_CONFIG.length);
  return env;
}
