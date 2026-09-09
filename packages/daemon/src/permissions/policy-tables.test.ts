/**
 * `qaBashPathVerdict` (T017 review round, opus blocker 3 — QA's `cat`/
 * `head`/`grep` Bash rule). New file: no `policy-tables.test.ts` existed
 * before this round (`roleVerdict`/`qaVerdict` were previously only
 * exercised indirectly via `hook/decide.test.ts`/`responder.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { qaBashPathVerdict } from './policy-tables';

const WORKTREE = '/repo/.worktrees/TKT-0001-qa';
const DENY_LIST = ['spec/input.md', 'out/**'];

describe('qaBashPathVerdict', () => {
  test('denies "cat" of a denied path (relative)', () => {
    const verdict = qaBashPathVerdict('cat spec/input.md', WORKTREE, DENY_LIST);
    expect(verdict).toEqual({
      action: 'deny',
      reason: 'QA may not read contract inputs/outputs (§13)',
    });
  });

  test('denies "cat" of a denied path (absolute, under the worktree)', () => {
    const verdict = qaBashPathVerdict(`cat ${WORKTREE}/spec/input.md`, WORKTREE, DENY_LIST);
    expect(verdict?.action).toBe('deny');
  });

  test('denies "head" and "tail" the same way', () => {
    expect(qaBashPathVerdict('head spec/input.md', WORKTREE, DENY_LIST)?.action).toBe('deny');
    expect(qaBashPathVerdict('tail -n 20 spec/input.md', WORKTREE, DENY_LIST)?.action).toBe('deny');
  });

  test('denies "grep" on the PATH argument, not the pattern (first non-flag arg is the pattern)', () => {
    const verdict = qaBashPathVerdict('grep -n TODO spec/input.md', WORKTREE, DENY_LIST);
    expect(verdict?.action).toBe('deny');
  });

  test('a grep pattern that happens to look like the denied path does not itself trigger denial', () => {
    // "spec/input.md" as the PATTERN (searching some other, allowed file) —
    // the path argument (src/a.ts) is what's checked, not the pattern text.
    const verdict = qaBashPathVerdict('grep spec/input.md src/a.ts', WORKTREE, DENY_LIST);
    expect(verdict).toBeUndefined();
  });

  test('allows a non-denied path', () => {
    expect(qaBashPathVerdict('cat src/a.ts', WORKTREE, DENY_LIST)).toBeUndefined();
  });

  test('a glob deny pattern (out/**) matches a nested path', () => {
    const verdict = qaBashPathVerdict('cat out/reports/nested.json', WORKTREE, DENY_LIST);
    expect(verdict?.action).toBe('deny');
  });

  test('an empty deny list never denies (no-op for non-QA callers / tickets with no contract paths)', () => {
    expect(qaBashPathVerdict('cat spec/input.md', WORKTREE, [])).toBeUndefined();
  });

  test('a binary outside the gated set (e.g. "ls") is untouched', () => {
    expect(qaBashPathVerdict('ls spec/input.md', WORKTREE, DENY_LIST)).toBeUndefined();
  });

  test('a chained command still denies on the atom that reads a denied path', () => {
    const verdict = qaBashPathVerdict('echo start && cat spec/input.md', WORKTREE, DENY_LIST);
    expect(verdict?.action).toBe('deny');
  });

  test('DESIGN-GAP (documented, not a regression): a preceding "cd" is not tracked — a relative arg still resolves against worktreePath, not the changed directory', () => {
    // "cd sub && cat ../spec/input.md" would, with real shell semantics,
    // read the same file `cat spec/input.md` reads directly — but this
    // checker (like the rest of this policy table) parses atoms
    // independently and never tracks a `cd`'s effect on later atoms. Not
    // fixed here: `cmd.parseCommandIntoAtoms` has no cwd-tracking API to
    // reuse, and adding one is a larger change than this rule warrants.
    const verdict = qaBashPathVerdict('cd sub && cat ../spec/input.md', WORKTREE, DENY_LIST);
    expect(verdict).toBeUndefined();
  });
});
