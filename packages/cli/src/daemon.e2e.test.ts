/**
 * T112 acceptance, end to end against the **real** CLI binary (no
 * in-process shortcut): `agile daemon start` on a temp `AGILE_HOME` runs
 * `agiled` detached, `daemon status` reports its pid, a second `start` is a
 * no-op that prints that same pid, `agile status` works from a cwd that is
 * not a git repo at all, the daemon is still alive with no work to do, and
 * `agile daemon stop` ends it and clears the pidfile.
 *
 * T125 acceptance on top of that: **every** command here runs from a plain
 * non-git directory, `agile daemon start` included, with no registered repo
 * at all — the daemon is one process for every registered repo (§7.1), so
 * the operator's cwd is not an input to starting it. The port comes from
 * `<home>/config.yaml` (a free one picked per run) so a daemon someone else
 * left on the default 4600 cannot fail this test.
 *
 * Offline: no vendor, no network. Replaces the deleted `run.e2e.test.ts`
 * (which drove the deleted `agile run`) in `test:integration`.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TEST_GITHUB_CONFIG, writeFreePortConfig } from './test-support';

const CLI_ENTRY = join(import.meta.dir, 'index.ts');

let home: string;
/**
 * A directory that is deliberately **not** a git repo. T125: this is the
 * cwd for every command in this file, `daemon start` included.
 */
let nonRepo: string;

function runCli(
  args: string[],
  opts: { cwd: string; env?: Record<string, string> } = { cwd: process.cwd() },
): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, CLI_ENTRY, ...args], {
    cwd: opts.cwd,
    // T167: an empty `TYPESAFE_API_KEY` is no key, so a key exported in the
    // operator's shell never reaches these daemons (and no call is made).
    env: { ...process.env, AGILE_HOME: home, AGILE_LIVE: '', TYPESAFE_API_KEY: '', ...opts.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const dec = new TextDecoder();
  return {
    code: proc.exitCode ?? 1,
    stdout: dec.decode(proc.stdout),
    stderr: dec.decode(proc.stderr),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-daemon-e2e-home-'));
  // Bind somewhere nothing else is, not the default 4600 — another
  // worker's suite (or the operator's own daemon) may hold it.
  await writeFreePortConfig(home);
  nonRepo = mkdtempSync(join(tmpdir(), 'agile-daemon-e2e-nonrepo-'));
  // A directory inside `nonRepo` could still find a git toplevel if the OS
  // temp dir happened to sit inside a repo; assert it does not.
  const probe = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
    cwd: nonRepo,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (probe.exitCode === 0) throw new Error(`temp dir ${nonRepo} is inside a git repo`);
});

afterEach(() => {
  // Never leave a daemon behind, whatever the test did.
  const pidPath = join(home, 'agiled.pid');
  if (existsSync(pidPath)) {
    const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  for (const dir of [home, nonRepo]) rmSync(dir, { recursive: true, force: true });
});

test('daemon start|status|stop lifecycle on a temp AGILE_HOME', async () => {
  expect(runCli(['init'], { cwd: nonRepo }).code).toBe(0);

  // Nothing running yet: `daemon status` says so and exits non-zero.
  const before = runCli(['daemon', 'status'], { cwd: nonRepo });
  expect(before.code).toBe(1);
  expect(before.stdout).toContain('not running');

  // start — detached; the CLI returns while the daemon keeps running.
  const started = runCli(['daemon', 'start'], { cwd: nonRepo });
  expect(started.stderr + started.stdout).toContain('agiled started');
  expect(started.code).toBe(0);
  const pid = Number(/pid=(\d+)/.exec(started.stdout)?.[1]);
  expect(Number.isFinite(pid)).toBe(true);
  expect(isAlive(pid)).toBe(true);

  // The pidfile is in the home, not in any repo.
  expect(existsSync(join(home, 'agiled.pid'))).toBe(true);
  expect(readFileSync(join(home, 'agiled.pid'), 'utf8').trim()).toBe(String(pid));
  expect(existsSync(join(nonRepo, '.agile-daemon.lock'))).toBe(false);
  // stdio went to a log file under `<home>/log/`.
  expect(existsSync(join(home, 'log', 'agiled.log'))).toBe(true);

  // `daemon status` reports the pid, from a non-repo cwd.
  const status = runCli(['daemon', 'status'], { cwd: nonRepo });
  expect(status.code).toBe(0);
  expect(status.stdout).toContain(`pid=${pid}`);
  // T167: whether a classifier key is loaded — none here.
  expect(status.stdout).toContain('classifier key: none loaded');

  // A second `start` is a no-op that prints the running pid.
  const again = runCli(['daemon', 'start'], { cwd: nonRepo });
  expect(again.code).toBe(0);
  expect(again.stdout).toContain('already running');
  expect(again.stdout).toContain(`pid=${pid}`);
  expect(readFileSync(join(home, 'agiled.pid'), 'utf8').trim()).toBe(String(pid));

  // `agile status` talks to the daemon over the socket with no repo cwd —
  // it resolves the socket from the home, never from `git rev-parse`.
  const clientStatus = runCli(['status', '--json'], { cwd: nonRepo });
  expect(clientStatus.code).toBe(0);
  const parsed = JSON.parse(clientStatus.stdout) as { daemon: { pid: number; stateRoot: string } };
  expect(parsed.daemon.pid).toBe(pid);
  expect(parsed.daemon.stateRoot).toBe(home);

  // There is no work at all, and there never was: the daemon does not exit
  // because work finished (D9).
  await sleep(1500);
  expect(isAlive(pid)).toBe(true);
  expect(runCli(['daemon', 'status'], { cwd: nonRepo }).stdout).toContain(`pid=${pid}`);

  // stop ends it and clears the pidfile.
  const stopped = runCli(['daemon', 'stop'], { cwd: nonRepo });
  expect(stopped.code).toBe(0);
  expect(stopped.stdout).toContain('agiled stopped');
  expect(isAlive(pid)).toBe(false);
  expect(existsSync(join(home, 'agiled.pid'))).toBe(false);

  const after = runCli(['daemon', 'status'], { cwd: nonRepo });
  expect(after.code).toBe(1);
  expect(after.stdout).toContain('not running');
}, 60_000);

test('the state home holds the daemon, not the cwd: no .agile/ is created there', () => {
  expect(runCli(['init'], { cwd: nonRepo }).code).toBe(0);
  const started = runCli(['daemon', 'start'], { cwd: nonRepo });
  expect(started.code).toBe(0);
  try {
    expect(existsSync(join(nonRepo, '.agile'))).toBe(false);
    // T125: nor is anything else — the deleted `agile.config.yaml` overlay
    // and the git probe that looked for it both wrote/read here.
    expect(existsSync(join(nonRepo, '.agile-daemon-cache'))).toBe(false);
    expect(existsSync(join(dirname(home), '.agile'))).toBe(false);
  } finally {
    runCli(['daemon', 'stop'], { cwd: nonRepo });
  }
}, 60_000);

test('T167: daemon status says a classifier key is loaded and where from, never the key', async () => {
  const fakeKey = 'fake-t167-key-never-printed-4242';
  const port = await writeFreePortConfig(home);
  writeFileSync(
    join(home, 'config.yaml'),
    `port: ${port}\nclassifier:\n  api_key: ${fakeKey}\n${TEST_GITHUB_CONFIG}`,
  );
  expect(runCli(['init'], { cwd: nonRepo }).code).toBe(0);
  expect(runCli(['daemon', 'start'], { cwd: nonRepo }).code).toBe(0);
  try {
    const status = runCli(['daemon', 'status'], { cwd: nonRepo });
    expect(status.stdout).toContain('classifier key: loaded (from config.yaml)');
    expect(status.stdout + status.stderr).not.toContain(fakeKey);
    const json = runCli(['daemon', 'status', '--json'], { cwd: nonRepo });
    expect(json.stdout).not.toContain(fakeKey);
    expect(JSON.parse(json.stdout).classifier).toMatchObject({ source: 'config', loaded: true });
  } finally {
    runCli(['daemon', 'stop'], { cwd: nonRepo });
  }
  const log = readFileSync(join(home, 'log', 'agiled.log'), 'utf8');
  expect(log).not.toContain(fakeKey);
}, 60_000);

test('T167: a key from the environment is reported as such', () => {
  expect(runCli(['init'], { cwd: nonRepo }).code).toBe(0);
  const env = { TYPESAFE_API_KEY: 'fake-t167-env-key' };
  expect(runCli(['daemon', 'start'], { cwd: nonRepo, env }).code).toBe(0);
  try {
    const status = runCli(['daemon', 'status'], { cwd: nonRepo });
    expect(status.stdout).toContain('classifier key: loaded (from TYPESAFE_API_KEY)');
    expect(status.stdout).not.toContain('fake-t167-env-key');
  } finally {
    runCli(['daemon', 'stop'], { cwd: nonRepo });
  }
}, 60_000);

test('T210: an AGILE_HOME that is a file is refused by every command, one line', () => {
  const file = join(nonRepo, 'not-a-dir');
  writeFileSync(file, 'x');
  for (const args of [
    ['init'],
    ['daemon', 'start'],
    ['daemon', 'stop'],
    ['status'],
    ['stream', 'list'],
  ]) {
    const r = runCli(args, { cwd: nonRepo, env: { AGILE_HOME: file } });
    expect(r.code).toBe(1);
    const lines = r.stderr.trim().split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(`AGILE_HOME=${file}`);
    expect(lines[0]).toContain('not a directory');
  }
});

test('T210: start on a held port names the holder; stop with no pidfile hints at it', async () => {
  expect(runCli(['init'], { cwd: nonRepo }).code).toBe(0);
  // A different home's daemon on this home's port.
  const other = mkdtempSync(join(tmpdir(), 'agile-daemon-e2e-other-'));
  try {
    writeFileSync(join(other, 'config.yaml'), readFileSync(join(home, 'config.yaml'), 'utf8'));
    const first = runCli(['daemon', 'start'], { cwd: nonRepo, env: { AGILE_HOME: other } });
    expect(first.code).toBe(0);
    const otherPid = Number(/pid=(\d+)/.exec(first.stdout)?.[1]);

    const held = runCli(['daemon', 'start'], { cwd: nonRepo });
    expect(held.code).toBe(1);
    expect(held.stderr).toContain('address in use');
    const hasLsof = !Bun.spawnSync(['sh', '-c', 'command -v lsof']).exitCode;
    if (hasLsof) {
      expect(held.stderr).toContain(`held by pid ${otherPid}`);
      expect(held.stderr).toContain('looks like another agiled');
    } else {
      expect(held.stderr).toContain('lsof not available');
    }

    const stop = runCli(['daemon', 'stop'], { cwd: nonRepo });
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain('not running');
    if (hasLsof) expect(stop.stdout).toContain(`held by pid ${otherPid}`);

    runCli(['daemon', 'stop'], { cwd: nonRepo, env: { AGILE_HOME: other } });
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
}, 60_000);

test('T221: a test daemon never runs gh, not even one first on PATH', async () => {
  expect(runCli(['init'], { cwd: nonRepo }).code).toBe(0);
  const stubDir = join(nonRepo, 'bin');
  const marker = join(nonRepo, 'gh-ran');
  mkdirSync(stubDir);
  writeFileSync(join(stubDir, 'gh'), `#!/bin/sh\ntouch '${marker}'\necho stub-token\n`);
  chmodSync(join(stubDir, 'gh'), 0o755);
  const env = { PATH: `${stubDir}:${process.env.PATH ?? ''}` };
  expect(runCli(['daemon', 'start'], { cwd: nonRepo, env }).code).toBe(0);
  const status = runCli(['daemon', 'status'], { cwd: nonRepo, env });
  expect(status.code).toBe(0);
  expect(status.stdout).toContain('GitHub auth: unavailable');
  expect(existsSync(marker)).toBe(false);
  expect(runCli(['daemon', 'stop'], { cwd: nonRepo, env }).code).toBe(0);
  // Four CLI processes, the daemon's start and stop among them: past bun's 5 s default on a loaded box.
}, 20_000);
