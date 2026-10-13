import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawnSession } from '@agile-agents/acp-client';
import { ulid } from '@agile-agents/shared';
import { type DaemonHandle, startDaemon } from './daemon';
import { RoutedEventService } from './events';
import { runInit } from './init';
import { LockError } from './lock';
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

describe('T444: sessions a dead daemon left running', () => {
  test('end at start: the node reads idle, not Working for good', async () => {
    // A home as a daemon killed mid-turn leaves it: a node working, its session running.
    const store = StateStore.open(runInit(home).stateRoot);
    const { StreamService } = await import('./streams/service');
    const node = await new StreamService(store).create('human', { title: 'mid-turn', goal: 'g' });
    const session = ulid();
    await store.updateStream('daemon', node.id, (before) => ({
      ...before,
      agent: { ...before.agent, status: 'working' },
      sessions: [{ id: session, vendor: 'claude', model: 'm', role: 'worker', status: 'running' }],
    }));
    await store.flush();
    store.close();

    handle = await startDaemon({ port: 0, socketPath: join(repo, '.agile-daemon.sock') });
    const after = handle.streamService?.get(node.id);
    expect(after).toBeDefined();
    expect(after?.agent.status).toBe('idle');
    expect(after?.sessions.map((s) => s.status)).toEqual(['stopped']);
  });
});

describe('T533: a second start changes nothing before it holds the lock', () => {
  /** Records every agent start; never runs a vendor. */
  function recordingSpawn(): { spawn: typeof spawnSession; calls: unknown[] } {
    const calls: unknown[] = [];
    const spawn = ((opts: unknown) => {
      calls.push(opts);
      throw new Error('no agent may start here');
    }) as unknown as typeof spawnSession;
    return { spawn, calls };
  }

  test('with a live daemon holding a running session, the second start leaves it all alone', async () => {
    runInit(home);
    const first = recordingSpawn();
    handle = await startDaemon({
      port: 0,
      socketPath: join(repo, 'a.sock'),
      titleRun: null,
      gateTickMs: 0,
      overlapRecomputeMs: 0,
      spawn: first.spawn,
    });
    const streams = handle.streamService;
    const store = handle.store;
    if (streams === undefined || store === undefined) throw new Error('no state home');
    const node = await streams.create('human', { title: 'live work', goal: 'g' }, {});
    const session = ulid();
    await store.updateStream('daemon', node.id, (before) => ({
      ...before,
      agent: { ...before.agent, status: 'working' },
      sessions: [{ id: session, vendor: 'claude', model: 'm', role: 'worker', status: 'running' }],
    }));
    // A line for the node while it works: pending, as the live daemon queues it.
    // Emitted by another service instance, so the live daemon's delivery never hears it.
    await new RoutedEventService(store).emit({
      type: 'human_line',
      subject: node.id,
      payload: { body: 'one more thing' },
      by: 'human',
      routing: [{ node: node.id, because: 'self' }],
    });
    await store.flush();
    const before = streams.get(node.id);
    const threadBefore = streams.readThread(node.id).entries;
    const deliveriesBefore = store.readDeliveries(node.id);
    const lockBefore = readFileSync(handle.config.lockPath, 'utf8');

    const second = recordingSpawn();
    await expect(
      startDaemon({
        port: 0,
        socketPath: join(repo, 'b.sock'),
        titleRun: null,
        gateTickMs: 0,
        overlapRecomputeMs: 0,
        spawn: second.spawn,
      }),
    ).rejects.toThrow(LockError);
    // Past the delivery's coalescing delay (250 ms): a wake would have started by now.
    await Bun.sleep(600);

    const after = streams.get(node.id);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.sessions[0]?.status).toBe('running');
    expect(after.agent.status).toBe('working');
    expect(after.human.status).toBe(before.human.status);
    expect(streams.readThread(node.id).entries).toEqual(threadBefore);
    expect(store.readDeliveries(node.id)).toEqual(deliveriesBefore);
    expect(second.calls).toHaveLength(0);
    expect(first.calls).toHaveLength(0);
    // The live daemon still holds its lock, and its socket was never touched.
    expect(readFileSync(handle.config.lockPath, 'utf8')).toBe(lockBefore);
    expect(existsSync(join(repo, 'b.sock'))).toBe(false);
    const pong = await call(handle.rpc.socketPath, {
      jsonrpc: '2.0',
      id: 1,
      method: 'daemon.ping',
    });
    expect('result' in pong ? pong.result : undefined).toBe('pong');
  });

  test('a start that fails after taking the lock (port in use) releases it and stops what it started', async () => {
    runInit(home);
    const squatter = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('busy'),
    });
    try {
      const { spawn, calls } = recordingSpawn();
      await expect(
        startDaemon({
          port: squatter.port,
          socketPath: join(repo, '.agile-daemon.sock'),
          titleRun: null,
          spawn,
        }),
      ).rejects.toThrow(/address in use/);
      const lockPath = join(home, 'agiled.pid');
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(join(repo, '.agile-daemon.sock'))).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      squatter.stop(true);
    }
    // Nothing of the failed start is left holding the home: a fresh start succeeds.
    handle = await startDaemon({ port: 0, socketPath: join(repo, '.agile-daemon.sock') });
    expect(readFileSync(handle.config.lockPath, 'utf8').trim()).toBe(String(process.pid));
  });

  test('a lock left by a daemon that crashed (started or still starting) is reclaimed', async () => {
    runInit(home);
    const lockPath = join(home, 'agiled.pid');
    const deadPid = 999_999_999;
    for (const stale of [String(deadPid), `starting ${deadPid}`]) {
      writeFileSync(lockPath, stale);
      handle = await startDaemon({ port: 0, socketPath: join(repo, '.agile-daemon.sock') });
      expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
      await handle.stop();
      handle = undefined;
      expect(existsSync(lockPath)).toBe(false);
    }
  });
});

describe('T478: auto-close, as the daemon wires it', () => {
  test('goal_met with nothing on the branch closes the node; with a commit it stays to merge', async () => {
    const git = (args: string[], cwd: string) => {
      const run = Bun.spawnSync(['git', ...args], { cwd });
      if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
    };
    git(['config', 'user.email', 'test@example.com'], repo);
    git(['config', 'user.name', 'Test'], repo);
    git(['checkout', '-q', '-b', 'main'], repo);
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'initial'], repo);
    const store = StateStore.open(runInit(home).stateRoot);
    await store.addRepo('demo', { path: repo });
    await store.flush();
    store.close();

    handle = await startDaemon({ port: 0, socketPath: join(repo, '.agile-daemon.sock') });
    const streams = handle.streamService;
    if (streams === undefined) throw new Error('no stream service');
    const { ProjectService } = await import('./projects');
    const project = await new ProjectService(handle.store as StateStore, streams).create({
      name: 'Shop',
    });

    /** A node on its own branch; `commit` puts a change on it. Then a turn that says goal_met. */
    const finish = async (slug: string, commit: boolean): Promise<string> => {
      const node = await streams.create('human', {
        title: slug,
        goal: 'g',
        repo: 'demo',
        parent: project.root,
        auto_close: true,
      });
      const worktree = join(repo, '.worktrees', slug);
      git(['worktree', 'add', '-q', '-b', slug, worktree, 'main'], repo);
      if (commit) {
        writeFileSync(join(worktree, `${slug}.txt`), 'x\n');
        git(['add', '-A'], worktree);
        git(['commit', '-q', '-m', slug], worktree);
      }
      const session = ulid();
      await (handle?.store as StateStore).updateStream('daemon', node.id, (before) => ({
        ...before,
        branch: slug,
        worktree,
        sessions: [
          { id: session, vendor: 'claude', model: 'm', role: 'worker', status: 'running' },
        ],
      }));
      await streams.update('daemon', node.id, { agent: { status: 'working' } });
      await streams.update('agent', node.id, {
        agent: { goal_met: { session, at: new Date().toISOString(), summary: 'done' } },
      });
      // As attach ends a turn: the session stops, then the node reads done.
      await (handle?.store as StateStore).updateStream('daemon', node.id, (before) => ({
        ...before,
        sessions: before.sessions.map((s) => ({ ...s, status: 'stopped' as const })),
      }));
      await streams.update('daemon', node.id, { agent: { status: 'done' } });
      return node.id;
    };

    const clean = await finish('s-clean', false);
    const changed = await finish('s-changed', true);
    const deadline = Date.now() + 5000;
    while (streams.get(clean).human.status === 'open' && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(streams.get(clean).human.status).toBe('closed');
    expect(streams.get(clean).human.note).toContain('auto-closed');
    await Bun.sleep(100);
    expect(streams.get(changed).human.status).toBe('open');
  });
});

describe('T489: the vendor self-check in the daemon', () => {
  test('wired to the socket and the cockpit; under bun test it never runs a real vendor', async () => {
    runInit(home);
    handle = await startDaemon({ port: 0, socketPath: join(repo, '.agile-daemon.sock') });
    const status = await call(handle.rpc.socketPath, {
      jsonrpc: '2.0',
      id: 1,
      method: 'vendors.status',
    });
    const result = ('result' in status ? status.result : undefined) as {
      mode: string;
      vendors: Array<{ vendor: string }>;
    };
    expect(result.mode).toBe('auto');
    expect(result.vendors.map((v) => v.vendor).sort()).toEqual(
      ['antigravity', 'claude', 'codex', 'cursor', 'gemini', 'grok', 'pi'].sort(),
    );
    // T500: Antigravity's server isn't installed in a fresh home, and under bun test
    // Install fetches nothing.
    const agy = (
      result.vendors as Array<{ vendor: string; installed: boolean; install?: unknown }>
    ).find((v) => v.vendor === 'antigravity');
    expect(agy?.installed).toBe(false);
    expect(agy?.install).toMatchObject({ version: '1.2.1', installing: false });
    const install = await call(handle.rpc.socketPath, {
      jsonrpc: '2.0',
      id: 3,
      method: 'vendors.install',
      params: { vendor: 'antigravity' },
    });
    expect('error' in install).toBe(true);
    expect('error' in install ? install.error.message : '').toMatch(
      /nothing is downloaded or unpacked under bun test|no build for this computer/,
    );
    expect(existsSync(join(home, 'bridges', 'antigravity', '1.2.1', 'manifest.yaml'))).toBe(false);
    const got = await fetch(`http://127.0.0.1:${handle.http.port}/api/settings/vendor-checks`);
    expect(got.status).toBe(200);
    // Installed or not on this machine, a check here spawns nothing: it is refused.
    const checked = await call(handle.rpc.socketPath, {
      jsonrpc: '2.0',
      id: 2,
      method: 'vendors.check',
      params: { vendor: 'claude' },
    });
    expect('error' in checked).toBe(true);
    const error = 'error' in checked ? checked.error : undefined;
    expect(error?.message).toMatch(/never runs a real vendor under bun test|not on the/);
  });
});
