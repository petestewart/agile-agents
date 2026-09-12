import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GateService } from '../gates';
import { type HttpServerHandle, startHttpServer } from '../http';
import { runInit } from '../init';
import { StateStore } from '../store';
import { HttpJiraClient } from './client';
import { type FakeJiraHandle, startFakeJira } from './fake-jira';
import { JiraSync } from './jira';
import { buildSyncRpcMethods, requireProjectKey } from './rpc';

let repo: string;
let stateRoot: string;
let store: StateStore;
let jira: FakeJiraHandle;
let sync: JiraSync;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-sync-rpc-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  jira = startFakeJira();
  sync = new JiraSync({
    store,
    client: new HttpJiraClient({
      baseUrl: jira.baseUrl,
      email: 'pete@example.com',
      apiToken: 'token-123',
    }),
    onError: () => {},
  });
});

afterEach(() => {
  jira.stop();
  store.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('sync.* rpc', () => {
  test('link, status, unlink round-trip', async () => {
    const methods = buildSyncRpcMethods(sync);
    expect((await methods['sync.jira_status']?.({})) as { linked: boolean }).toMatchObject({
      linked: false,
    });
    await methods['sync.jira_link']?.({ project: 'LED' });
    expect((await methods['sync.jira_status']?.({})) as { project: string }).toMatchObject({
      linked: true,
      project: 'LED',
    });
    expect(await methods['sync.jira_unlink']?.({})).toMatchObject({
      unlinked: true,
      project: 'LED',
    });
  });

  test('a bad project key is an invalid-params error, not a write', () => {
    expect(() => requireProjectKey('not a key')).toThrow(/invalid "project"/);
    expect(() => requireProjectKey(undefined)).toThrow(/invalid "project"/);
    expect(requireProjectKey('LED')).toBe('LED');
  });
});

describe('/api/sync/jira routes', () => {
  let server: HttpServerHandle;

  afterEach(async () => {
    await server?.stop();
  });

  function start(withSync: boolean): HttpServerHandle {
    server = startHttpServer({
      port: 0,
      version: '0.0.0-test',
      stateRoot,
      startedAt: Date.now(),
      store,
      gates: new GateService(store),
      ...(withSync ? { jiraSync: sync } : {}),
    });
    return server;
  }

  test('503s when Jira is not configured', async () => {
    const s = start(false);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/sync/jira`)).status).toBe(503);
    const post = await fetch(`http://127.0.0.1:${s.port}/api/sync/jira/link`, {
      method: 'POST',
      body: JSON.stringify({ project: 'LED' }),
    });
    expect(post.status).toBe(503);
  });

  test('link / status / unlink', async () => {
    const s = start(true);
    const linked = await fetch(`http://127.0.0.1:${s.port}/api/sync/jira/link`, {
      method: 'POST',
      body: JSON.stringify({ project: 'LED' }),
    });
    expect(linked.status).toBe(200);
    expect((await linked.json()) as { project: string }).toMatchObject({ project: 'LED' });

    const status = await (await fetch(`http://127.0.0.1:${s.port}/api/sync/jira`)).json();
    expect(status as { linked: boolean }).toMatchObject({ linked: true, project: 'LED' });

    const unlinked = await fetch(`http://127.0.0.1:${s.port}/api/sync/jira/unlink`, {
      method: 'POST',
    });
    expect((await unlinked.json()) as { unlinked: boolean; project?: string }).toEqual({
      unlinked: true,
      project: 'LED',
    });
  });

  test('rejects a cross-origin link POST and a bad project key', async () => {
    const s = start(true);
    const crossOrigin = await fetch(`http://127.0.0.1:${s.port}/api/sync/jira/link`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
      body: JSON.stringify({ project: 'LED' }),
    });
    expect(crossOrigin.status).toBe(403);

    const bad = await fetch(`http://127.0.0.1:${s.port}/api/sync/jira/link`, {
      method: 'POST',
      body: JSON.stringify({ project: 'nope nope' }),
    });
    expect(bad.status).toBe(400);
    expect(sync.getLink()).toBeUndefined();
  });
});
