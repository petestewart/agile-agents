import { describe, expect, test } from 'bun:test';
import { classifyPermissionRequest } from './classify';
import type { AcpPermissionRequestParams } from './types';

function paramsWith(toolCall: AcpPermissionRequestParams['toolCall']): AcpPermissionRequestParams {
  return { sessionId: 's', toolCall, options: [] };
}

describe('classifyPermissionRequest', () => {
  test('maps known ACP tool kinds through', () => {
    for (const kind of ['read', 'edit', 'execute', 'fetch'] as const) {
      expect(classifyPermissionRequest(paramsWith({ kind })).toolClass).toBe(kind);
    }
  });

  test('unrecognized/absent kind classifies as other (safe default)', () => {
    expect(classifyPermissionRequest(paramsWith({ kind: 'switch_mode' })).toolClass).toBe('other');
    expect(classifyPermissionRequest(paramsWith({})).toolClass).toBe('other');
  });

  test('pulls command from rawInput.command', () => {
    const classified = classifyPermissionRequest(
      paramsWith({ kind: 'execute', rawInput: { command: 'git status' } }),
    );
    expect(classified.command).toBe('git status');
  });

  test('pulls a target path from rawInput.file_path, falling back to .path', () => {
    expect(
      classifyPermissionRequest(paramsWith({ kind: 'edit', rawInput: { file_path: '/a/b.ts' } }))
        .targetPath,
    ).toBe('/a/b.ts');
    expect(
      classifyPermissionRequest(paramsWith({ kind: 'edit', rawInput: { path: '/a/c.ts' } }))
        .targetPath,
    ).toBe('/a/c.ts');
  });

  test('empty rawInput (the shape every recorded spike payload actually has) yields undefined fields, not a crash', () => {
    const classified = classifyPermissionRequest(paramsWith({ kind: 'edit', rawInput: {} }));
    expect(classified.targetPath).toBeUndefined();
    expect(classified.command).toBeUndefined();
    expect(classified.url).toBeUndefined();
  });

  test('missing toolCall entirely does not throw', () => {
    expect(() =>
      classifyPermissionRequest({
        sessionId: 's',
        options: [],
      } as unknown as AcpPermissionRequestParams),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Title fallback (round-2 QA/review requirement) — only used when rawInput
// carries neither a command nor a path; never overrides rawInput.
// ---------------------------------------------------------------------------
describe('classifyPermissionRequest — title fallback', () => {
  test('"Run <cmd>" recovers a command when rawInput is empty', () => {
    const classified = classifyPermissionRequest(
      paramsWith({ kind: 'execute', title: 'Run git push origin main', rawInput: {} }),
    );
    expect(classified.command).toBe('git push origin main');
    expect(classified.titleFallbackUsed).toBe(true);
  });

  test('"Run npm test" recovers a command', () => {
    const classified = classifyPermissionRequest(
      paramsWith({ kind: 'execute', title: 'Run npm test', rawInput: {} }),
    );
    expect(classified.command).toBe('npm test');
    expect(classified.titleFallbackUsed).toBe(true);
  });

  test('"Edit <path>" / "Write <path>" / "Create <path>" recover a target path', () => {
    expect(
      classifyPermissionRequest(paramsWith({ kind: 'edit', title: 'Edit small.txt', rawInput: {} }))
        .targetPath,
    ).toBe('small.txt');
    expect(
      classifyPermissionRequest(paramsWith({ kind: 'edit', title: 'Write new.txt', rawInput: {} }))
        .targetPath,
    ).toBe('new.txt');
    expect(
      classifyPermissionRequest(
        paramsWith({ kind: 'edit', title: 'Create fixtures/data.json', rawInput: {} }),
      ).targetPath,
    ).toBe('fixtures/data.json');
  });

  test('"Edit /outside/x.ts" recovers the (absolute, outside-worktree) path as-is', () => {
    const classified = classifyPermissionRequest(
      paramsWith({ kind: 'edit', title: 'Edit /outside/x.ts', rawInput: {} }),
    );
    expect(classified.targetPath).toBe('/outside/x.ts');
    expect(classified.titleFallbackUsed).toBe(true);
  });

  test('"Read" / "Read File" confirm a read tool class when kind itself did not say so', () => {
    expect(
      classifyPermissionRequest(paramsWith({ kind: undefined, title: 'Read File', rawInput: {} }))
        .toolClass,
    ).toBe('read');
    expect(
      classifyPermissionRequest(paramsWith({ kind: undefined, title: 'Read', rawInput: {} }))
        .toolClass,
    ).toBe('read');
  });

  test('kind already says read — Read/Read File title is redundant, not a fallback use', () => {
    const classified = classifyPermissionRequest(
      paramsWith({ kind: 'read', title: 'Read File', rawInput: {} }),
    );
    expect(classified.toolClass).toBe('read');
    expect(classified.titleFallbackUsed).toBe(false);
  });

  test('free-form prose that matches none of the shapes stays kind-only ("Terminal")', () => {
    const classified = classifyPermissionRequest(
      paramsWith({ kind: 'execute', title: 'Terminal', rawInput: {} }),
    );
    expect(classified.command).toBeUndefined();
    expect(classified.titleFallbackUsed).toBe(false);
  });

  test('rawInput.command present is never overridden by title', () => {
    const classified = classifyPermissionRequest(
      paramsWith({
        kind: 'execute',
        title: 'Run something misleading',
        rawInput: { command: 'git status' },
      }),
    );
    expect(classified.command).toBe('git status');
    expect(classified.titleFallbackUsed).toBe(false);
  });

  test('rawInput.file_path present is never overridden by title', () => {
    const classified = classifyPermissionRequest(
      paramsWith({
        kind: 'edit',
        title: 'Edit somewhere-else.ts',
        rawInput: { file_path: '/a/b.ts' },
      }),
    );
    expect(classified.targetPath).toBe('/a/b.ts');
    expect(classified.titleFallbackUsed).toBe(false);
  });

  test('no title at all stays kind-only', () => {
    const classified = classifyPermissionRequest(paramsWith({ kind: 'execute', rawInput: {} }));
    expect(classified.command).toBeUndefined();
    expect(classified.titleFallbackUsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-3 review fix: prose after "Edit"/"Write"/"Create" must not be
// laundered into a fictitious in-worktree path.
// ---------------------------------------------------------------------------
describe('classifyPermissionRequest — title fallback does not trust prose as a path (round 3)', () => {
  test('bare-word and multi-word prose captures yield no targetPath at all', () => {
    for (const title of [
      'Edit file',
      'Edit the config file',
      'Write the report',
      'Create a new module',
      'Edit two files: a.ts and /etc/passwd',
    ]) {
      const classified = classifyPermissionRequest(
        paramsWith({ kind: 'edit', title, rawInput: {} }),
      );
      expect(classified.targetPath).toBeUndefined();
      expect(classified.titleFallbackUsed).toBe(false);
    }
  });

  test('a quoted capture with a space is still trusted (it looks like a path once unquoted)', () => {
    const classified = classifyPermissionRequest(
      paramsWith({ kind: 'edit', title: 'Edit "src/a b.ts"', rawInput: {} }),
    );
    expect(classified.targetPath).toBe('src/a b.ts');
    expect(classified.titleFallbackUsed).toBe(true);
  });

  test('a real-looking unquoted capture (has a slash or extension, no spaces) is still trusted', () => {
    expect(
      classifyPermissionRequest(paramsWith({ kind: 'edit', title: 'Edit small.txt', rawInput: {} }))
        .targetPath,
    ).toBe('small.txt');
    expect(
      classifyPermissionRequest(
        paramsWith({ kind: 'edit', title: 'Edit src/lib/a.ts', rawInput: {} }),
      ).targetPath,
    ).toBe('src/lib/a.ts');
  });

  test('a leading ~ expands against the real home directory and is never an in-worktree path', () => {
    const classified = classifyPermissionRequest(
      paramsWith({ kind: 'edit', title: 'Edit ~/.bashrc', rawInput: {} }),
    );
    expect(classified.targetPath).toBeDefined();
    expect(classified.targetPath).not.toContain('~');
    expect(classified.targetPath?.endsWith('.bashrc')).toBe(true);
    expect(classified.titleFallbackUsed).toBe(true);
  });

  test('bare ~ alone expands to the home directory itself', () => {
    const classified = classifyPermissionRequest(
      paramsWith({ kind: 'edit', title: 'Edit ~', rawInput: {} }),
    );
    expect(classified.targetPath).toBeDefined();
    expect(classified.targetPath).not.toContain('~');
  });
});

// ---------------------------------------------------------------------------
// Round-3 review requirement: toolCall.locations, checked between rawInput
// and title.
// ---------------------------------------------------------------------------
describe('classifyPermissionRequest — locations (round 3)', () => {
  test('locations[0].path is used when rawInput has neither a command nor a path', () => {
    const classified = classifyPermissionRequest(
      paramsWith({
        kind: 'edit',
        title: 'Edit file',
        rawInput: {},
        locations: [{ path: '/etc/passwd' }],
      }),
    );
    expect(classified.targetPath).toBe('/etc/passwd');
    expect(classified.locationsUsed).toBe(true);
    expect(classified.titleFallbackUsed).toBe(false);
  });

  test('locations takes precedence over the title fallback, even when the title alone would have matched', () => {
    const classified = classifyPermissionRequest(
      paramsWith({
        kind: 'edit',
        title: 'Edit small.txt',
        rawInput: {},
        locations: [{ path: '/etc/passwd' }],
      }),
    );
    expect(classified.targetPath).toBe('/etc/passwd');
    expect(classified.locationsUsed).toBe(true);
  });

  test('rawInput still takes precedence over locations', () => {
    const classified = classifyPermissionRequest(
      paramsWith({
        kind: 'edit',
        rawInput: { file_path: '/a/b.ts' },
        locations: [{ path: '/etc/passwd' }],
      }),
    );
    expect(classified.targetPath).toBe('/a/b.ts');
    expect(classified.locationsUsed).toBe(false);
  });

  test('an empty locations array falls through to the title fallback', () => {
    const classified = classifyPermissionRequest(
      paramsWith({ kind: 'edit', title: 'Edit small.txt', rawInput: {}, locations: [] }),
    );
    expect(classified.targetPath).toBe('small.txt');
    expect(classified.locationsUsed).toBe(false);
    expect(classified.titleFallbackUsed).toBe(true);
  });
});
