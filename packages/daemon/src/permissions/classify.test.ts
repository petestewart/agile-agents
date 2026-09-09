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
