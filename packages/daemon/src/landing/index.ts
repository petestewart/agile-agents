/**
 * `packages/daemon/src/landing/**` — the landing path (design/
 * cockpit-design.md §8.2): `git.ts` is the git plumbing, `service.ts` is
 * `LandingService.land()` (gate, diff rules, `merge --no-ff`, close the
 * stream, remove the worktree), `rpc.ts` is the `land.*` RPC edge.
 *
 * T122 deleted the old merge owner (ticket -> integration -> main, the
 * land gate and the halt-backed pre-commit guard) with the rest of the
 * ceremony layer; T132 renamed what was left (`merge/`) to `landing/` and
 * built the one landing path on top of it.
 */

export * from './git';
export * from './service';
export * from './rpc';
