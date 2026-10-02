import { describe, expect, test } from 'bun:test';
import { validateHomeConfig } from './home-config';
import { validateInboxItem } from './inbox';
import { ReadRootSchema, validatePermissionPosture } from './posture';
import { validateProject, validateProjectUpdateInput } from './project';

describe('permission posture (T457)', () => {
  test('trusted or ask, in the home config and on a project', () => {
    expect(validatePermissionPosture('trusted')).toBe('trusted');
    expect(() => validatePermissionPosture('yolo')).toThrow();
    expect(validateHomeConfig({ permissions: 'trusted' }).permissions).toBe('trusted');
    expect(() => validateHomeConfig({ permissions: 'bypass' })).toThrow();
    const project = validateProject({
      id: 'P-01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'Cents',
      root: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      created_at: '2026-09-27T00:00:00.000Z',
      permissions: 'ask',
      read_roots: ['/home/pete/code/other'],
    });
    expect(project.read_roots).toEqual(['/home/pete/code/other']);
    expect(validateProjectUpdateInput({ permissions: null, read_roots: null })).toEqual({
      permissions: null,
      read_roots: null,
    });
  });

  test('a read root is absolute and normalised, never /', () => {
    for (const ok of ['/a', '/home/pete/code/other', '/tmp/x y']) {
      expect([ok, ReadRootSchema.safeParse(ok).success]).toEqual([ok, true]);
    }
    for (const bad of ['/', '', 'rel/dir', '/a/', '/a//b', '/a/../b', '/a/./b', '~/code']) {
      expect([bad, ReadRootSchema.safeParse(bad).success]).toEqual([bad, false]);
    }
  });

  test('only a gate inbox item carries a read root', () => {
    const base = {
      id: 'HIL-01ARZ3NDEKTSV4RRFFQ69G5FAV',
      stream: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      stream_path: ['Cents', 'Cents check'],
      ts: '2026-09-27T00:00:00.000Z',
      context: 'classifier_review: read /x — why',
      read_root: '/home/pete/code/other',
    };
    expect(validateInboxItem({ ...base, kind: 'gate' }).read_root).toBe('/home/pete/code/other');
    expect(() => validateInboxItem({ ...base, kind: 'question' })).toThrow('read root');
  });
});
