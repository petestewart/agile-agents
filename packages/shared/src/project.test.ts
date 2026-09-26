import { describe, expect, test } from 'bun:test';
import { ulid } from './ids';
import {
  PROJECT_ID_PATTERN,
  projectNameKey,
  validateProject,
  validateProjectCreateInput,
  validateProjectUpdateInput,
} from './project';

const base = () => ({
  id: `P-${ulid()}`,
  name: 'Shop',
  root: ulid(),
  created_at: '2026-09-24T00:00:00.000Z',
});

describe('Project schema (projects-design §14.1)', () => {
  test('fills the defaults: no repos, autonomy advise/advise', () => {
    const p = validateProject(base());
    expect(p.repos).toEqual([]);
    expect(p.autonomy).toEqual({ coordinator: 'advise', director: 'advise' });
    expect(p.archived).toBeUndefined();
  });

  test('ids are P-<ulid>', () => {
    expect(PROJECT_ID_PATTERN.test(`P-${ulid()}`)).toBe(true);
    expect(PROJECT_ID_PATTERN.test(ulid())).toBe(false);
    expect(() => validateProject({ ...base(), id: `R-${ulid()}` })).toThrow(/P-<ulid>/);
  });

  test('is strict and refuses a bad root, autonomy or tracker', () => {
    expect(() => validateProject({ ...base(), extra: 1 })).toThrow(/invalid Project/);
    expect(() => validateProject({ ...base(), root: 'nope' })).toThrow(/root/);
    expect(() =>
      validateProject({ ...base(), autonomy: { coordinator: 'rule', director: 'advise' } }),
    ).toThrow(/autonomy/);
    expect(validateProject({ ...base(), tracker: { system: 'jira' } }).tracker).toEqual({
      system: 'jira',
      push_status: false,
    });
  });

  test('create input takes only name and repos; update refuses id/root', () => {
    expect(validateProjectCreateInput({ name: ' Shop ' })).toEqual({ name: 'Shop', repos: [] });
    expect(() => validateProjectCreateInput({ name: 'x', root: ulid() })).toThrow();
    expect(() => validateProjectCreateInput({ name: '' })).toThrow();
    expect(() => validateProjectUpdateInput({ root: ulid() })).toThrow();
    expect(validateProjectUpdateInput({ delivery: null }).delivery).toBeNull();
  });

  test('name key is case-insensitive', () => {
    expect(projectNameKey(' Shop')).toBe(projectNameKey('SHOP'));
  });
});
