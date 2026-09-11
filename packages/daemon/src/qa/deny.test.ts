import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTicket } from '@agile-agents/shared';
import { decideQaRead, globToRegExp, matchesAnyPattern, qaReadDenyList } from './deny';

describe('globToRegExp / matchesAnyPattern', () => {
  test('exact path matches only itself', () => {
    expect(matchesAnyPattern('packages/api/auth/jwt.ts', ['packages/api/auth/jwt.ts'])).toBe(true);
    expect(matchesAnyPattern('packages/api/auth/other.ts', ['packages/api/auth/jwt.ts'])).toBe(
      false,
    );
  });

  test('trailing ** matches the directory itself and everything under it', () => {
    const patterns = ['packages/api/auth/**'];
    expect(matchesAnyPattern('packages/api/auth', patterns)).toBe(true);
    expect(matchesAnyPattern('packages/api/auth/jwt.ts', patterns)).toBe(true);
    expect(matchesAnyPattern('packages/api/auth/nested/deep.ts', patterns)).toBe(true);
    expect(matchesAnyPattern('packages/api/other.ts', patterns)).toBe(false);
  });

  test('single * matches within one segment only', () => {
    const patterns = ['packages/api/*.ts'];
    expect(matchesAnyPattern('packages/api/jwt.ts', patterns)).toBe(true);
    expect(matchesAnyPattern('packages/api/auth/jwt.ts', patterns)).toBe(false);
  });
});

function makeTicket() {
  return validateTicket({
    id: 'TKT-0001',
    title: 'Fixture',
    status: 'in_qa',
    contract: {
      inputs: ['packages/api/auth/**'],
      outputs: ['packages/api/auth/jwt.ts', 'tests/auth/jwt.test.ts'],
      acceptance: ['x'],
    },
    history: [],
  });
}

describe('qaReadDenyList', () => {
  test('with no worktreePath, returns the raw contract patterns', () => {
    expect(qaReadDenyList(makeTicket())).toEqual([
      'packages/api/auth/**',
      'packages/api/auth/jwt.ts',
      'tests/auth/jwt.test.ts',
    ]);
  });

  test('with a worktreePath, also resolves existing files in the clone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agile-qa-deny-'));
    try {
      mkdirSync(join(dir, 'packages/api/auth'), { recursive: true });
      writeFileSync(join(dir, 'packages/api/auth/jwt.ts'), '// impl\n');
      writeFileSync(join(dir, 'packages/api/auth/other.ts'), '// impl2\n');

      const list = qaReadDenyList(makeTicket(), dir);
      expect(list).toContain(join(dir, 'packages/api/auth/jwt.ts'));
      expect(list).toContain(join(dir, 'packages/api/auth/other.ts'));
      // Raw patterns still included even where nothing matched (outputs entry for a file not yet created).
      expect(list).toContain('tests/auth/jwt.test.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('decideQaRead', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agile-qa-decide-'));
    mkdirSync(join(dir, 'packages/api/auth'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'packages/api/auth/jwt.ts'), '// impl\n');
    writeFileSync(join(dir, 'tests/other.test.ts'), '// test\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('denies a read of a contract input path (relative)', () => {
    const decision = decideQaRead(
      { role: 'qa', ticket: makeTicket(), worktreePath: dir },
      'packages/api/auth/jwt.ts',
    );
    expect(decision).toEqual({
      allow: false,
      reason: 'QA may not read contract inputs/outputs (§13)',
    });
  });

  test('denies a read of a contract input path (absolute)', () => {
    const decision = decideQaRead(
      { role: 'qa', ticket: makeTicket(), worktreePath: dir },
      join(dir, 'packages/api/auth/jwt.ts'),
    );
    expect(decision.allow).toBe(false);
  });

  test('allows a read outside contract.inputs/outputs', () => {
    const decision = decideQaRead(
      { role: 'qa', ticket: makeTicket(), worktreePath: dir },
      'tests/other.test.ts',
    );
    expect(decision).toEqual({ allow: true });
  });

  test('never denies for a non-qa role', () => {
    const decision = decideQaRead(
      { role: 'engineer', ticket: makeTicket(), worktreePath: dir },
      'packages/api/auth/jwt.ts',
    );
    expect(decision).toEqual({ allow: true });
  });

  test('review round nit: a symlink pointing at a denied path denies too (realpath, not literal path text)', () => {
    symlinkSync(join(dir, 'packages/api/auth/jwt.ts'), join(dir, 'alias.ts'));
    const decision = decideQaRead(
      { role: 'qa', ticket: makeTicket(), worktreePath: dir },
      join(dir, 'alias.ts'),
    );
    expect(decision.allow).toBe(false);
  });
});
