/**
 * T343: the git env a read-only session is spawned with. The hook lets a
 * reviewer run only `git diff`/`log`/`show`/`status`, but repo settings can
 * still make those run a program. What this env neutralises (checked against
 * git 2.43):
 * - tree attributes: `GIT_ATTR_SOURCE` is the empty tree, so no tracked
 *   `.gitattributes` binds a `diff=`/`filter=` driver (textconv, diff command,
 *   clean filter);
 * - the named config keys, forced through `GIT_CONFIG_*` after every config
 *   file: `diff.external` (empty, so a repo that sets it fails closed with a
 *   fatal error; `git diff --no-ext-diff` still works), `core.fsmonitor`
 *   (boolean `false`, never exec'd), `core.hooksPath`, `core.pager`, and the
 *   `gpg.*program`s a signed commit runs under `log.showSignature` or `%G?`;
 * - the pager: `GIT_PAGER` beats `pager.<cmd>`, and `cat` is git's "no pager"
 *   (never exec'd, so no PATH lookup).
 * Programs are absolute paths, never resolved through PATH.
 *
 * What it does NOT cover: `$GIT_DIR/info/attributes` (read whatever
 * `GIT_ATTR_SOURCE` says, and shared by every worktree of a repo) and a
 * driver of any other name in the repo's config. No env can enumerate those;
 * they are protected by the write layer, which lets no session write the
 * repo's shared git dir or its config (`policy-tables.ts`, the tier-0 sandbox).
 * The hook's allowlist refuses `VAR=`, `env`, `unset` and `export`, so the
 * agent cannot take this env off again.
 */

import type { PermissionRole } from './types';

/** Git's well-known empty tree: attributes are read from it, so no `diff=` binding applies. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** On Linux and macOS alike; exec'd directly, so never a bare name. */
const ABSOLUTE_FALSE = '/usr/bin/false';

/** Config forced through `GIT_CONFIG_KEY_n`, applied after every config file. */
const READ_ONLY_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['diff.external', ''],
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.pager', 'cat'],
  ['gpg.program', ABSOLUTE_FALSE],
  ['gpg.openpgp.program', ABSOLUTE_FALSE],
  ['gpg.x509.program', ABSOLUTE_FALSE],
  ['gpg.ssh.program', ABSOLUTE_FALSE],
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
