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
