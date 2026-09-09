import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import { dispatch } from '../rpc';
import { StateStore } from '../store/store';
import { QuotaService } from './records';
import { buildQuotaRpcMethods } from './rpc';

let repo: string;
let store: StateStore;
let methods: Record<string, ReturnType<typeof buildQuotaRpcMethods>[string]>;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-quota-rpc-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  const quota = new QuotaService({ store });
  methods = buildQuotaRpcMethods(quota, store);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function call<T>(method: string, params?: unknown): Promise<T> {
  const response = await dispatch(methods, { jsonrpc: '2.0', id: 1, method, params });
  if (!response) throw new Error('no response');
  if ('error' in response) throw new Error(response.error.message);
  return response.result as T;
}

describe('quota.* RPC', () => {
  test('quota.list returns the default seeded vendors.yaml account', async () => {
    const listed = await call<Array<{ vendor: string; account: string }>>('quota.list');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ vendor: 'claude', account: 'default' });
  });

  test('quota.record_429 sets cooldown and quota.list reflects it', async () => {
    const updated = await call<{ cooldown_until: string | null }>('quota.record_429', {
      vendor: 'claude',
      account: 'default',
      retryAfterSeconds: 30,
    });
    expect(updated.cooldown_until).not.toBeNull();

    const listed = await call<Array<{ vendor: string; account: string; cooldown_until: string | null }>>(
      'quota.list',
    );
    expect(listed[0]?.cooldown_until).not.toBeNull();
  });

  test('quota.route round-trips a routing decision and reroutes to none after a 429 exhausts the only account', async () => {
    await call('quota.record_429', { vendor: 'claude', account: 'default' });
    const result = await call<{ none: true; reason: string } | Array<{ vendor: string }>>('quota.route', {
      role: 'engineer',
      tier: 'standard',
    });
    // Only account configured is now in cooldown -> no candidate.
    expect(result).toMatchObject({ none: true });
  });

  test('quota.route with a second account available returns it after the first is exhausted', async () => {
    await store.putVendors({
      claude: { accounts: [{ id: 'default', auth: 'subscription' }] },
      openai: { accounts: [{ id: 'chatgpt', auth: 'subscription' }] },
    });
    await call('quota.record_429', { vendor: 'claude', account: 'default' });
    const result = await call<Array<{ vendor: string; account: string }>>('quota.route', {
      role: 'engineer',
      tier: 'standard',
    });
    expect(result).toEqual([{ vendor: 'openai', account: 'chatgpt' }]);
  });
});
