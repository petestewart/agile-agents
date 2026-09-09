/**
 * `packages/daemon/src/merge/**` — the merge and integration owner (T019).
 * See `owner.ts`, `precommit.ts`, `git.ts`, `rpc.ts` for the pieces; this is
 * the package barrel. Also the exact file `precommit.ts`'s generated
 * `pre-commit` hook script imports at commit time (`checkCommitAllowed`) —
 * its absolute path is baked into that script by `installPreCommitHook`, so
 * this file must keep exporting `checkCommitAllowed` under this name.
 */

export * from './git';
export * from './owner';
export * from './precommit';
export * from './rpc';
