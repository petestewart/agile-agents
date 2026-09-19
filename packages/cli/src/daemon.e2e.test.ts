/**
 * T112 acceptance, end to end against the **real** CLI binary (no
 * in-process shortcut): `agile daemon start` on a temp `AGILE_HOME` runs
 * `agiled` detached, `daemon status` reports its pid, a second `start` is a
 * no-op that prints that same pid, `agile status` works from a cwd that is
 * not a git repo at all, the daemon is still alive with no work to do, and
 * `agile daemon stop` ends it and clears the pidfile.
 *
 * Offline: no vendor, no network. Replaces the deleted `run.e2e.test.ts`
 * (which drove the deleted `agile run`) in `test:integration`.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CLI_ENTRY = join(import.meta.dir, 'index.ts');

let home: string;
/** A real git repo to start the daemon from (the daemon still resolves a repo root). */
let repo: string;
/** A directory that is deliberately **not** a git repo — `agile status` must still work there. */
let nonRepo: string;

function runCli(
  args: string[],
  opts: { cwd: string } = { cwd: process.cwd() },
): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, CLI_ENTRY, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, AGILE_HOME: home, AGILE_LIVE: '' },
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

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-daemon-e2e-repo-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  home = mkdtempSync(join(tmpdir(), 'agile-daemon-e2e-home-'));
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
  for (const dir of [repo, home, nonRepo]) rmSync(dir, { recursive: true, force: true });
});

test('daemon start|status|stop lifecycle on a temp AGILE_HOME', async () => {
  expect(runCli(['init'], { cwd: repo }).code).toBe(0);

  // Nothing running yet: `daemon status` says so and exits non-zero.
  const before = runCli(['daemon', 'status'], { cwd: nonRepo });
  expect(before.code).toBe(1);
  expect(before.stdout).toContain('not running');

  // start — detached; the CLI returns while the daemon keeps running.
  const started = runCli(['daemon', 'start'], { cwd: repo });
  expect(started.stderr + started.stdout).toContain('agiled started');
  expect(started.code).toBe(0);
  const pid = Number(/pid=(\d+)/.exec(started.stdout)?.[1]);
  expect(Number.isFinite(pid)).toBe(true);
  expect(isAlive(pid)).toBe(true);

  // The pidfile is in the home, not in any repo.
  expect(existsSync(join(home, 'agiled.pid'))).toBe(true);
  expect(readFileSync(join(home, 'agiled.pid'), 'utf8').trim()).toBe(String(pid));
  expect(existsSync(join(repo, '.agile-daemon.lock'))).toBe(false);
  // stdio went to a log file under `<home>/log/`.
  expect(existsSync(join(home, 'log', 'agiled.log'))).toBe(true);

  // `daemon status` reports the pid, from a non-repo cwd.
  const status = runCli(['daemon', 'status'], { cwd: nonRepo });
  expect(status.code).toBe(0);
  expect(status.stdout).toContain(`pid=${pid}`);

  // A second `start` is a no-op that prints the running pid.
  const again = runCli(['daemon', 'start'], { cwd: repo });
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

test('the state home holds the daemon, not the repo: no .agile/ is created in it', () => {
  expect(runCli(['init'], { cwd: repo }).code).toBe(0);
  const started = runCli(['daemon', 'start'], { cwd: repo });
  expect(started.code).toBe(0);
  try {
    expect(existsSync(join(repo, '.agile'))).toBe(false);
    expect(existsSync(join(dirname(home), '.agile'))).toBe(false);
  } finally {
    runCli(['daemon', 'stop'], { cwd: nonRepo });
  }
}, 60_000);
