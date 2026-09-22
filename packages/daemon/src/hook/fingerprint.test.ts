import { describe, expect, test } from 'bun:test';
import { fingerprintCall } from './fingerprint';

const WORKTREE = '/tmp/wt';

describe('fingerprintCall — what an approval is allowed to unlock (T138)', () => {
  test('an edit is keyed on the normalised absolute path, however it was addressed', () => {
    const absolute = fingerprintCall(
      { tool_name: 'Edit', tool_input: { file_path: '/tmp/wt/package.json' } },
      WORKTREE,
    );
    const relative = fingerprintCall(
      { tool_name: 'Edit', tool_input: { file_path: './sub/../package.json' } },
      WORKTREE,
    );
    expect(absolute?.path).toBe('/tmp/wt/package.json');
    expect(relative?.fingerprint).toBe(absolute?.fingerprint);
  });

  test('a different file is a different call, and so is a different tool', () => {
    const manifest = fingerprintCall(
      { tool_name: 'Edit', tool_input: { file_path: '/tmp/wt/package.json' } },
      WORKTREE,
    );
    const lockfile = fingerprintCall(
      { tool_name: 'Edit', tool_input: { file_path: '/tmp/wt/bun.lock' } },
      WORKTREE,
    );
    const written = fingerprintCall(
      { tool_name: 'Write', tool_input: { file_path: '/tmp/wt/package.json' } },
      WORKTREE,
    );
    expect(lockfile?.fingerprint).not.toBe(manifest?.fingerprint);
    expect(written?.fingerprint).not.toBe(manifest?.fingerprint);
  });

  test('a command is keyed on the command itself; only whitespace is normalised', () => {
    const push = fingerprintCall(
      { tool_name: 'Bash', tool_input: { command: 'git push   origin\n  main' } },
      WORKTREE,
    );
    expect(push?.command).toBe('git push origin main');
    expect(push?.fingerprint).toBe(
      fingerprintCall(
        { tool_name: 'Bash', tool_input: { command: 'git push origin main' } },
        WORKTREE,
      )?.fingerprint,
    );
    // A flag away is a different call — the whole point of gating it.
    expect(
      fingerprintCall({ tool_name: 'Bash', tool_input: { command: 'git push --force' } }, WORKTREE)
        ?.fingerprint,
    ).not.toBe(push?.fingerprint);
  });

  test('a payload with no tool name is unroutable — the caller denies outright', () => {
    expect(fingerprintCall({ tool_input: { command: 'git push' } }, WORKTREE)).toBeUndefined();
  });
});
