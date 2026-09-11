import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { cliInvocationToShell, normalizeCliBin, resolveCliBin, shellQuote } from './cli-bin';

const SRC_DIR = '/repo/packages/daemon/src/runner';
const DIST_DIR = '/repo/packages/daemon/dist/runner';
const SRC_ENTRY = join('/repo/packages/cli', 'src', 'index.ts');
const DIST_ENTRY = join('/repo/packages/cli', 'dist', 'index.js');

const none = () => null;

describe('resolveCliBin', () => {
  test('AGILE_CLI_BIN wins over everything', () => {
    const r = resolveCliBin({
      env: { AGILE_CLI_BIN: '/opt/agile/bin/agile' },
      moduleDir: SRC_DIR,
      exists: () => true,
      which: () => '/usr/local/bin/agile',
    });
    expect(r).toEqual({ command: '/opt/agile/bin/agile', args: [], source: 'env' });
  });

  test('from a source checkout, runs packages/cli/src/index.ts through the current bun', () => {
    const r = resolveCliBin({
      env: {},
      execPath: '/usr/local/bin/bun',
      moduleDir: SRC_DIR,
      exists: (p) => p === SRC_ENTRY,
      which: none,
    });
    expect(r).toEqual({ command: '/usr/local/bin/bun', args: [SRC_ENTRY], source: 'workspace' });
  });

  test('from a built tree, prefers packages/cli/dist/index.js', () => {
    const r = resolveCliBin({
      env: {},
      execPath: '/usr/local/bin/bun',
      moduleDir: DIST_DIR,
      exists: (p) => p === SRC_ENTRY || p === DIST_ENTRY,
      which: none,
    });
    expect(r.args).toEqual([DIST_ENTRY]);
    expect(r.source).toBe('workspace');
  });

  test('falls back to `agile` on $PATH when no workspace entry exists', () => {
    const r = resolveCliBin({
      env: {},
      moduleDir: SRC_DIR,
      exists: () => false,
      which: (name) => (name === 'agile' ? '/usr/local/bin/agile' : null),
    });
    expect(r).toEqual({ command: 'agile', args: [], source: 'path' });
  });

  test('reports `missing` (still bare `agile`) when nothing resolves, so the daemon can warn', () => {
    const r = resolveCliBin({ env: {}, moduleDir: SRC_DIR, exists: () => false, which: none });
    expect(r).toEqual({ command: 'agile', args: [], source: 'missing' });
  });

  test("the real resolver finds this monorepo's own CLI entry", () => {
    const r = resolveCliBin({ env: {} });
    expect(r.source).toBe('workspace');
    expect(r.command).toBe(process.execPath);
    expect(r.args[0]).toMatch(/packages\/cli\/(src\/index\.ts|dist\/index\.js)$/);
  });
});

describe('cliInvocationToShell / shellQuote', () => {
  test('bare names and plain paths stay unquoted', () => {
    expect(cliInvocationToShell({ command: 'agile', args: [] })).toBe('agile');
    expect(cliInvocationToShell({ command: '/usr/local/bin/bun', args: ['/repo/cli.ts'] })).toBe(
      '/usr/local/bin/bun /repo/cli.ts',
    );
  });

  test('paths with spaces or quotes are single-quoted for the hook shell', () => {
    expect(shellQuote('/Users/me/My Projects/cli.ts')).toBe("'/Users/me/My Projects/cli.ts'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(cliInvocationToShell({ command: '/opt/bun', args: ['/a b/index.ts'] })).toBe(
      "/opt/bun '/a b/index.ts'",
    );
  });
});

describe('normalizeCliBin', () => {
  test('bare string, structured, and undefined', () => {
    expect(normalizeCliBin('agile')).toEqual({ command: 'agile', args: [] });
    expect(normalizeCliBin({ command: '/b', args: ['x'] })).toEqual({ command: '/b', args: ['x'] });
    expect(normalizeCliBin(undefined)).toEqual({ command: 'agile', args: [] });
  });
});
