import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleLoadError, findRule, loadRules } from './rules';

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agile-rules-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function rulesDir(): string {
  const dir = join(stateRoot, 'rules');
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('loadRules', () => {
  test('returns [] when the rules dir does not exist', () => {
    expect(loadRules(stateRoot)).toEqual([]);
  });

  test('loads a markdown rule', () => {
    const dir = rulesDir();
    writeFileSync(
      join(dir, 'RULE-001.md'),
      '# RULE-001: No console.log\nUse the logger instead.\n',
    );
    const rules = loadRules(stateRoot);
    expect(rules).toEqual([
      { id: 'RULE-001', title: 'No console.log', text: 'Use the logger instead.' },
    ]);
  });

  test('loads a markdown rule with a bare title heading', () => {
    const dir = rulesDir();
    writeFileSync(join(dir, 'RULE-002.md'), '# No bare fetch\nWrap network calls.\n');
    const rules = loadRules(stateRoot);
    expect(rules[0]).toEqual({
      id: 'RULE-002',
      title: 'No bare fetch',
      text: 'Wrap network calls.',
    });
  });

  test('loads a yaml rule', () => {
    const dir = rulesDir();
    writeFileSync(
      join(dir, 'RULE-003.yaml'),
      'id: RULE-003\ntitle: No any\ntext: Never use the any type.\n',
    );
    const rules = loadRules(stateRoot);
    expect(rules[0]).toEqual({ id: 'RULE-003', title: 'No any', text: 'Never use the any type.' });
  });

  test('sorts and dedupes across files, in filename order', () => {
    const dir = rulesDir();
    writeFileSync(join(dir, 'RULE-002.md'), '# RULE-002: B\ntext b\n');
    writeFileSync(join(dir, 'RULE-001.md'), '# RULE-001: A\ntext a\n');
    const rules = loadRules(stateRoot);
    expect(rules.map((r) => r.id)).toEqual(['RULE-001', 'RULE-002']);
  });

  test('rejects a heading id that does not match the filename', () => {
    const dir = rulesDir();
    writeFileSync(join(dir, 'RULE-001.md'), '# RULE-002: Mismatch\nbody\n');
    expect(() => loadRules(stateRoot)).toThrow(RuleLoadError);
  });

  test('rejects a yaml id that does not match the filename', () => {
    const dir = rulesDir();
    writeFileSync(join(dir, 'RULE-001.yaml'), 'id: RULE-999\ntitle: X\ntext: Y\n');
    expect(() => loadRules(stateRoot)).toThrow(RuleLoadError);
  });

  test('skips a non-RULE file with a warning instead of throwing (opus review, blocker 3)', () => {
    const dir = rulesDir();
    writeFileSync(join(dir, 'README.md'), '# Rules\nSee individual RULE-###.md files.\n');
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      expect(loadRules(stateRoot)).toEqual([]);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some((args) => String(args[0]).includes('README.md'))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  // T046 defect 1: `agile init` seeds `rules/.gitkeep`, so the old
  // "warn on anything not RULE-###" branch printed a `skipping .gitkeep`
  // line on every tick of a clean run.
  test('skips hidden/temp clutter silently — no warning for a seeded .gitkeep', () => {
    const dir = rulesDir();
    writeFileSync(join(dir, '.gitkeep'), '');
    writeFileSync(join(dir, '.DS_Store'), '');
    writeFileSync(join(dir, 'RULE-001.md'), '# RULE-001: A\ntext a\n');
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const rules = loadRules(stateRoot);
      expect(rules.map((r) => r.id)).toEqual(['RULE-001']);
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('skips stray files but still loads real rules alongside them', () => {
    const dir = rulesDir();
    writeFileSync(join(dir, 'README.md'), '# Rules\n');
    writeFileSync(join(dir, 'RULE-001.md'), '# RULE-001: A\ntext a\n');
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const rules = loadRules(stateRoot);
      expect(rules.map((r) => r.id)).toEqual(['RULE-001']);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('rejects a body with no text', () => {
    const dir = rulesDir();
    writeFileSync(join(dir, 'RULE-001.md'), '# RULE-001: Title only\n');
    expect(() => loadRules(stateRoot)).toThrow(/no body text/);
  });

  test('findRule finds by id', () => {
    const dir = rulesDir();
    writeFileSync(join(dir, 'RULE-001.md'), '# RULE-001: A\ntext a\n');
    const rules = loadRules(stateRoot);
    expect(findRule(rules, 'RULE-001')?.title).toBe('A');
    expect(findRule(rules, 'RULE-404')).toBeUndefined();
  });
});
