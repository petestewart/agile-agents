import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverConfig, resolveHomePaths } from './config';

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

describe('discoverConfig (T125: no repo, no cwd, no git)', () => {
  // T125 acceptance: `agile daemon start` from a non-repo directory starts.
  // `discoverConfig` is where that used to die, so the regression lives here:
  // the resolver must not care where it is called from, and must not spawn
  // `git` to find out.
  test('resolves from a non-git cwd with no repo anywhere in its ancestry', () => {
    const outside = mkdtempSync(join(tmpdir(), 'agile-notgit-'));
    const previousCwd = process.cwd();
    process.env.AGILE_HOME = join(outside, 'home');
    try {
      process.chdir(outside);
      const config = discoverConfig();
      expect(config.home).toBe(join(outside, 'home'));
      expect(config.stateRoot).toBe(config.home);
      expect(config.port).toBe(4600);
      expect(config.socketPath).toBe(join(config.home, 'agiled.sock'));
      // T112 (D9): the pidfile belongs to the home, not a repo.
      expect(config.lockPath).toBe(join(config.home, 'agiled.pid'));
      // §7.5: the per-repo overlay is gone, so nothing is materialized in
      // the directory the operator happened to be standing in.
      expect(existsSync(join(outside, '.agile-daemon-cache'))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // The acceptance criterion "no `git` subprocess runs during daemon start",
  // asserted at its source: `discoverConfig` is the only thing that ever
  // spawned one.
  test('spawns no subprocess at all', () => {
    const spawnSync = Bun.spawnSync;
    const spawn = Bun.spawn;
    const calls: string[][] = [];
    try {
      // biome-ignore lint/suspicious/noExplicitAny: test double
      (Bun as any).spawnSync = (cmd: string[]) => {
        calls.push(cmd);
        throw new Error(`unexpected subprocess: ${cmd.join(' ')}`);
      };
      // biome-ignore lint/suspicious/noExplicitAny: test double
      (Bun as any).spawn = (cmd: string[]) => {
        calls.push(cmd);
        throw new Error(`unexpected subprocess: ${cmd.join(' ')}`);
      };
      process.env.AGILE_HOME = join(repo, 'home');
      discoverConfig();
      expect(calls).toEqual([]);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test double
      (Bun as any).spawnSync = spawnSync;
      // biome-ignore lint/suspicious/noExplicitAny: test double
      (Bun as any).spawn = spawn;
    }
  });

  // T111 (PLAN.md §5, D9): one state home, `$AGILE_HOME` or `~/.agile/`.
  test('AGILE_HOME sets the state home; the default is ~/.agile/', () => {
    process.env.AGILE_HOME = join(repo, '..', 'a-home');
    expect(discoverConfig().home).toBe(join(repo, '..', 'a-home'));

    Reflect.deleteProperty(process.env, 'AGILE_HOME');
    expect(discoverConfig().home).toBe(join(homedir(), '.agile'));
  });

  test('an explicit home option beats AGILE_HOME', () => {
    process.env.AGILE_HOME = '/tmp/env-home';
    expect(discoverConfig({ home: '/tmp/explicit-home' }).home).toBe('/tmp/explicit-home');
  });

  test('<home>/config.yaml sets the port and socket', () => {
    const home = mkdtempSync(join(tmpdir(), 'agile-discover-home-'));
    try {
      writeFileSync(join(home, 'config.yaml'), 'port: 5001\nsocketPath: /tmp/custom.sock\n');
      const config = discoverConfig({ home });
      expect(config.port).toBe(5001);
      expect(config.socketPath).toBe('/tmp/custom.sock');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('env vars override <home>/config.yaml', () => {
    const home = mkdtempSync(join(tmpdir(), 'agile-discover-home-env-'));
    try {
      writeFileSync(join(home, 'config.yaml'), 'port: 5001\n');
      process.env.AGILE_PORT = '5002';
      expect(discoverConfig({ home }).port).toBe(5002);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('explicit options override everything', () => {
    process.env.AGILE_PORT = '5002';
    expect(discoverConfig({ port: 5003 }).port).toBe(5003);
  });

  // §7.5 deletes the per-repo `agile.config.yaml`. A file left over from an
  // older install must not be read — silently honouring a stale port is how
  // a client ends up talking to nothing.
  test('ignores a leftover per-repo agile.config.yaml', () => {
    writeFileSync(join(repo, 'agile.config.yaml'), 'port: 5999\n');
    const previousCwd = process.cwd();
    process.env.AGILE_HOME = join(repo, 'home');
    try {
      process.chdir(repo);
      expect(discoverConfig().port).toBe(4600);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe('resolveHomePaths (no repo needed — T112, D9)', () => {
  test('resolves port, socket, pidfile and log paths from the home alone', () => {
    const home = join(repo, 'home');
    const paths = resolveHomePaths({ home });
    expect(paths.home).toBe(home);
    expect(paths.port).toBe(4600);
    expect(paths.socketPath).toBe(join(home, 'agiled.sock'));
    expect(paths.pidPath).toBe(join(home, 'agiled.pid'));
    expect(paths.logPath).toBe(join(home, 'log', 'agiled.log'));
    expect(paths.eventsPath).toBe(join(home, 'log', 'events.jsonl'));
  });

  test('<home>/config.yaml sets the port and socket; env beats the file', () => {
    const home = mkdtempSync(join(tmpdir(), 'agile-home-config-'));
    try {
      writeFileSync(join(home, 'config.yaml'), 'port: 5100\nsocketPath: /tmp/from-home.sock\n');
      expect(resolveHomePaths({ home }).port).toBe(5100);
      expect(resolveHomePaths({ home }).socketPath).toBe('/tmp/from-home.sock');
      process.env.AGILE_PORT = '5101';
      expect(resolveHomePaths({ home }).port).toBe(5101);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an unknown key in <home>/config.yaml is refused, never silently ignored', () => {
    const home = mkdtempSync(join(tmpdir(), 'agile-home-config-bad-'));
    try {
      writeFileSync(join(home, 'config.yaml'), 'prot: 5100\n');
      expect(() => resolveHomePaths({ home })).toThrow(/home config/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
