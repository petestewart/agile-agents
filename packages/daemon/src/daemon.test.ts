import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '@agile-agents/shared';
import { type DaemonHandle, startDaemon } from './daemon';
import { runInit } from './init';
import type { JsonRpcResponse } from './rpc';
import { StateStore } from './store';

let repo: string;
let home: string;
let previousHome: string | undefined;
let handle: DaemonHandle | undefined;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-daemon-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  // T111: the state home is `$AGILE_HOME`, outside the repo.
  home = mkdtempSync(join(tmpdir(), 'agile-daemon-home-'));
  previousHome = process.env.AGILE_HOME;
  process.env.AGILE_HOME = home;
});

afterEach(async () => {
  await handle?.stop();
  if (previousHome === undefined) Reflect.deleteProperty(process.env, 'AGILE_HOME');
  else process.env.AGILE_HOME = previousHome;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('startDaemon', () => {
  test('acquires the lock, and /health serves version + stateRoot', async () => {
    handle = await startDaemon({
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    expect(existsSync(handle.config.lockPath)).toBe(true);

    const res = await fetch(`http://127.0.0.1:${handle.http.port}/health`);
    const body = (await res.json()) as { version: string; stateRoot: string };
    expect(body.stateRoot).toBe(handle.config.stateRoot);
    expect(typeof body.version).toBe('string');
  });

  test('a second daemon for the same repo fails with a clear lock error', async () => {
    handle = await startDaemon({
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    await expect(
      startDaemon({ port: 0, socketPath: join(repo, '.agile-daemon.sock') }),
    ).rejects.toThrow(/already running/);
  });

  test('graceful shutdown removes the lock and closes the listeners', async () => {
    handle = await startDaemon({
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    const { lockPath } = handle.config;
    const { port } = handle.http;
    const { socketPath } = handle.rpc;

    await handle.stop();
    handle = undefined; // already stopped; afterEach shouldn't stop it again

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  test('stop() is idempotent', async () => {
    handle = await startDaemon({
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    await handle.stop();
    await handle.stop();
  });

  test('after shutdown, a fresh daemon can start for the same repo', async () => {
    handle = await startDaemon({
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    await handle.stop();
    handle = await startDaemon({
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
    });
    expect(existsSync(handle.config.lockPath)).toBe(true);
  });
});

function call(socketPath: string, request: Record<string, unknown>): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        socket.end();
        resolve(JSON.parse(line) as JsonRpcResponse);
      }
    });
    socket.on('error', reject);
  });
}

describe('T434: the quick drafts switch', () => {
  test('off, an untitled node asks the cheap model nothing; on again, it does', async () => {
    runInit(home);
    const asked: string[] = [];
    handle = await startDaemon({
      port: 0,
      socketPath: join(repo, '.agile-daemon.sock'),
      titleRun: async (prompt) => {
        asked.push(prompt);
        return 'A better title';
      },
    });
    const base = `http://127.0.0.1:${handle.http.port}`;
    const post = async (path: string, body: unknown) =>
      (await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((res) => res.json())) as Record<string, unknown>;
    expect(await (await fetch(`${base}/api/settings/quick-drafts`)).json()).toEqual({
      on: true,
      available: true,
    });
    const project = await post('/api/projects', { name: 'Shop' });
    const untitled = (goal: string) =>
      post('/api/streams', {
        project: project.id,
        title: goal,
        goal,
        auto_title: true,
        start: false,
      });

    await post('/api/settings/quick-drafts', { on: false });
    await untitled('first idea');
    await Bun.sleep(100);
    expect(asked).toEqual([]);

    await post('/api/settings/quick-drafts', { on: true });
    await untitled('second idea');
    const deadline = Date.now() + 5000;
    while (asked.length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('second idea');
  });
});
