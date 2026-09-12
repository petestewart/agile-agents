/**
 * `sync.*` RPC method tests. The HTTP routes these back (`/api/sync/jira*`)
 * are tested alongside their siblings in `packages/daemon/src/http.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import { StateStore } from '../store';
import { HttpJiraClient } from './client';
import { type FakeJiraHandle, startFakeJira } from './fake-jira';
import { JiraSync } from './jira';
import { buildSyncRpcMethods, requireProjectKey } from './rpc';

let repo: string;
let configPath: string;
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
  configPath = join(repo, 'agile.config.yaml');
  store = StateStore.open(init.stateRoot);
  jira = startFakeJira();
  sync = new JiraSync({
    store,
    client: new HttpJiraClient({
      baseUrl: jira.baseUrl,
      email: 'pete@example.com',
      apiToken: 'token-123',
    }),
    configPath,
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
