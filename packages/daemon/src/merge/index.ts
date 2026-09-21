/**
 * `packages/daemon/src/merge/**` — git plumbing for the landing path.
 * T122 deleted the merge owner (ticket -> integration -> main, the
 * sprint-review gate and the halt-backed pre-commit guard) with the rest of
 * the ceremony layer; `git.ts` is what T140's landing path builds on.
 */

export * from './git';
