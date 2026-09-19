import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

describe('discoverConfig', () => {
  test('finds the git toplevel from a nested cwd', () => {
    const nested = join(repo, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const config = discoverConfig({ cwd: nested });
    // Resolve symlinks (macOS /tmp is a symlink) before comparing.
    const repoBasename = repo.split('/').pop() ?? repo;
    expect(config.repoRoot.endsWith(repoBasename)).toBe(true);
    // T111: the state home is never inside the repo.
    expect(config.home).not.toContain(config.repoRoot);
    expect(config.stateRoot).toBe(config.home);
    // T112 (D9): the pidfile belongs to the home, not the repo.
    expect(config.lockPath).toBe(join(config.home, 'agiled.pid'));
  });

  // T111 (PLAN.md §5, D9): one state home, `$AGILE_HOME` or `~/.agile/`.
  test('AGILE_HOME sets the state home; the default is ~/.agile/', () => {
    process.env.AGILE_HOME = join(repo, '..', 'a-home');
    expect(discoverConfig({ cwd: repo }).home).toBe(join(repo, '..', 'a-home'));

    Reflect.deleteProperty(process.env, 'AGILE_HOME');
    expect(discoverConfig({ cwd: repo }).home).toBe(join(homedir(), '.agile'));
  });

  test('an explicit home option beats AGILE_HOME', () => {
    process.env.AGILE_HOME = '/tmp/env-home';
    expect(discoverConfig({ cwd: repo, home: '/tmp/explicit-home' }).home).toBe(
      '/tmp/explicit-home',
    );
  });

  test('defaults port and socket path when nothing is configured', () => {
    process.env.AGILE_HOME = join(repo, '..', 'a-home-defaults');
    const config = discoverConfig({ cwd: repo });
    expect(config.port).toBe(4600);
    // T112 (D9): the socket belongs to the home, so a client with no repo
    // cwd can find the one long-lived daemon.
    expect(config.socketPath).toBe(join(config.home, 'agiled.sock'));
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

  test("review round 1 blocker B2: a non-repo cwd (e.g. the operator's own $HOME) gets no .agile-daemon-cache left behind, even though the call throws", () => {
    // Review round 3 blocker B3: an earlier version of this test snapshotted
    // `readdirSync(tmpdir())` before/after and asserted no *other* entry
    // appeared — racy against every other process (and every other test
    // file in the same `bun test` run) also using the real, shared OS temp
    // dir; reproduced 2/5 full-suite runs on entries this test never wrote
    // (another process's `dockerProbeEnv` probe, `backend.test.ts`'s own
    // stub-docker dir in the same process). Fixed with the DI seam T037
    // round 4 built for `sandbox/backend.ts`: `discoverConfig`'s
    // `tempDirBase` points `findRepoRoot`'s no-repo-root fallback at this
    // test's own `mkdtempSync`'d directory instead of the real `os.tmpdir()`,
    // so the only thing asserted empty afterwards is a directory nothing
    // else on the host could possibly be touching.
    const outside = mkdtempSync(join(tmpdir(), 'agile-notgit-'));
    const tempDirBase = mkdtempSync(join(tmpdir(), 'agile-config-tempbase-'));
    try {
      expect(() => discoverConfig({ cwd: outside, tempDirBase })).toThrow(/not a git repository/);
      // Nothing materialized inside the non-repo directory itself — the old
      // bug used `startDir` (here, `outside`) directly as the sandbox cache
      // root, so `findRepoRoot`'s bootstrap git spawn left
      // `<outside>/.agile-daemon-cache/git/` behind despite the throw.
      expect(existsSync(join(outside, '.agile-daemon-cache'))).toBe(false);
      // Nor did it leak a fresh directory into the *injected* temp base
      // that outlives the call — the no-repo-root fallback's own
      // `mkdtempSync` must be cleaned up in every case, including the error
      // path. This directory is this test's own, so an empty result is a
      // hermetic, non-racy assertion (never the shared `os.tmpdir()`).
      expect(readdirSync(tempDirBase)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(tempDirBase, { recursive: true, force: true });
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
