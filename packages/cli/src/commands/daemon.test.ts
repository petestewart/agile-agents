/**
 * T127: `agile daemon start` must fail fast when something else already
 * holds the home's port.
 *
 * Pete's Phase 2 hand test: with a stale `agiled` from another home on 4600,
 * `start` waited the full 20 s pidfile timeout and then reported "no pidfile
 * … see the log", whose entire content was Bun's own `Failed to start
 * server. Is port 4600 in use?`. Two separate defects fed that:
 *
 *  1. the child never exited promptly — the foreground entry only set
 *     `process.exitCode` and left the loop to drain, so the parent's
 *     `child.exitCode` poll had nothing to see; and
 *  2. the child took the lock (i.e. wrote the pidfile) *before* binding the
 *     port, so the parent could equally well see that transient pidfile and
 *     report `agiled started` for a daemon that was already dying.
 *
 * Both cases are covered here: a listener on a free port, a temp home whose
 * `config.yaml` names that port, and `runDaemonStart` against the real CLI
 * entry — it must reject in under two seconds with the port, the way to
 * find the holder and the way to pick another port.
 */

import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from '../test-support';
import { formatDaemonStatus, runDaemonStart } from './daemon';

const CLI_ENTRY = join(import.meta.dir, '..', 'index.ts');

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A temp state home whose `config.yaml` points at an already-bound port. */
async function homeOnABusyPort(): Promise<{ home: string; port: number }> {
  const port = await freePort();
  const squatter = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('busy') });
  const home = mkdtempSync(join(tmpdir(), 'agile-busy-port-home-'));
  writeFileSync(join(home, 'config.yaml'), `port: ${port}\n`);
  cleanups.push(() => {
    squatter.stop(true);
    rmSync(home, { recursive: true, force: true });
  });
  return { home, port };
}

test('daemon start fails fast, and says what to do, when the port is busy', async () => {
  const { home, port } = await homeOnABusyPort();

  const startedAt = Date.now();
  let message = '';
  try {
    await runDaemonStart({ home, cwd: home, cliEntry: CLI_ENTRY });
    throw new Error('runDaemonStart resolved, but the port is held by another process');
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  const elapsed = Date.now() - startedAt;

  expect(message).toContain('agiled did not start');
  // The port, the holder lookup, and both ways to pick another port.
  expect(message).toContain(`127.0.0.1:${port}`);
  expect(message).toContain(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  expect(message).toContain(join(home, 'config.yaml'));
  expect(message).toContain('AGILE_PORT');
  // Nothing about a 20 s wait: the failure is known as soon as the child dies.
  expect(message).not.toContain('20000ms');
  expect(elapsed).toBeLessThan(2_000);

  // The child released what it took: no pidfile left for the next `start`.
  expect(existsSync(join(home, 'agiled.pid'))).toBe(false);
}, 30_000);

test('a busy port is never reported as a started daemon, even with a state home', async () => {
  const { home } = await homeOnABusyPort();
  // `.agile`-style state present: this is the shape that used to make the
  // child write its pidfile (the lock) long before the failing bind, so the
  // parent saw the transient file and printed `agiled started`.
  const init = Bun.spawnSync([process.execPath, CLI_ENTRY, 'init'], {
    cwd: home,
    env: { ...process.env, AGILE_HOME: home, AGILE_LIVE: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(init.exitCode).toBe(0);

  const startedAt = Date.now();
  await expect(runDaemonStart({ home, cwd: home, cliEntry: CLI_ENTRY })).rejects.toThrow(
    /address in use/,
  );
  expect(Date.now() - startedAt).toBeLessThan(2_000);
  expect(existsSync(join(home, 'agiled.pid'))).toBe(false);
}, 30_000);

test('T166: daemon status prints the state home first', () => {
  const base = {
    home: '/h/agile',
    port: 4777,
    socketPath: '/h/agile/agiled.sock',
    pidPath: '/h/agile/agiled.pid',
    logPath: '/h/agile/log/agiled.log',
  };
  const stopped = formatDaemonStatus({ ...base, running: false });
  expect(stopped.split('\n')[0]).toBe('home: /h/agile');
  const running = formatDaemonStatus({ ...base, running: true, pid: 42 });
  expect(running.split('\n')[0]).toBe('home: /h/agile');
  expect(running).toContain('agiled running: pid=42');
});

test('T221: daemon status says whether GitHub auth is available, never the token', () => {
  const base = {
    home: '/h/agile',
    port: 4777,
    socketPath: '/h/agile/agiled.sock',
    pidPath: '/h/agile/agiled.pid',
    logPath: '/h/agile/log/agiled.log',
    running: true,
    pid: 42,
  };
  expect(formatDaemonStatus({ ...base, githubAuth: 'available' })).toContain(
    'GitHub auth: available',
  );
  expect(formatDaemonStatus({ ...base, githubAuth: 'unavailable' })).toContain(
    'GitHub auth: unavailable (run `gh auth login`)',
  );
});

test('T170: daemon status shows the resolved session default, never "default"', () => {
  const report = {
    home: '/h/agile',
    port: 4777,
    socketPath: '/h/agile/agiled.sock',
    pidPath: '/h/agile/agiled.pid',
    logPath: '/h/agile/log/agiled.log',
    running: true,
    pid: 42,
    sessionDefaults: { vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' as const },
  };
  expect(formatDaemonStatus(report)).toContain('session default: claude/claude-opus-5-5 · low');
  expect(formatDaemonStatus({ ...report, running: false })).toContain(
    'session default: claude/claude-opus-5-5 · low',
  );
});
