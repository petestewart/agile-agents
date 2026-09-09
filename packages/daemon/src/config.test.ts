import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverConfig } from './config';

let repo: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-config-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('discoverConfig', () => {
  test('finds the git toplevel from a nested cwd', () => {
    const nested = join(repo, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const config = discoverConfig({ cwd: nested });
    // Resolve symlinks (macOS /tmp is a symlink) before comparing.
    const repoBasename = repo.split('/').pop() ?? repo;
    expect(config.repoRoot.endsWith(repoBasename)).toBe(true);
    expect(config.stateRoot).toBe(join(config.repoRoot, '.agile'));
    expect(config.lockPath).toBe(join(config.repoRoot, '.agile-daemon.lock'));
  });

  test('defaults port and socket path when nothing is configured', () => {
    const config = discoverConfig({ cwd: repo });
    expect(config.port).toBe(4600);
    expect(config.socketPath).toBe(join(config.repoRoot, '.agile-daemon.sock'));
  });

  test('reads agile.config.yaml when present', () => {
    writeFileSync(join(repo, 'agile.config.yaml'), 'port: 5001\nsocketPath: /tmp/custom.sock\n');
    const config = discoverConfig({ cwd: repo });
    expect(config.port).toBe(5001);
    expect(config.socketPath).toBe('/tmp/custom.sock');
  });

  test('env vars override the config file', () => {
    writeFileSync(join(repo, 'agile.config.yaml'), 'port: 5001\n');
    process.env.AGILE_PORT = '5002';
    const config = discoverConfig({ cwd: repo });
    expect(config.port).toBe(5002);
  });

  test('explicit options override everything', () => {
    process.env.AGILE_PORT = '5002';
    const config = discoverConfig({ cwd: repo, port: 5003 });
    expect(config.port).toBe(5003);
  });

  test('throws a clear error outside a git repo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'agile-notgit-'));
    try {
      expect(() => discoverConfig({ cwd: outside })).toThrow(/not a git repository/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
