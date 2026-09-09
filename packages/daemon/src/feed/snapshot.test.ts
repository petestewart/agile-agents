/**
 * T023 addition: `buildSnapshot`'s new (optional) `quota` parameter and
 * `FeedSnapshot.quota` field (§17 "Sprint strip" vendor barometer).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import { GateService } from '../gates';
import { QuotaService } from '../quota/records';
import { StateStore } from '../store';
import { buildSnapshot } from './snapshot';

let repo: string;
let store: StateStore;
let gates: GateService;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-feed-quota-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  gates = new GateService(store);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

test('with no QuotaService given, quota is an empty array (backward compatible)', () => {
  const snapshot = buildSnapshot(store, gates);
  expect(snapshot.quota).toEqual([]);
});

describe('with a QuotaService', () => {
  test('lists every configured account, remaining_fraction from the Quota record', async () => {
    const quota = new QuotaService({ store });
    const snapshot = buildSnapshot(store, gates, undefined, quota);
    expect(snapshot.quota).toHaveLength(1);
    expect(snapshot.quota[0]).toMatchObject({ vendor: 'claude', account: 'default', remaining_fraction: 1 });
  });

  test('reflects cooldown_until after a 429', async () => {
    const quota = new QuotaService({ store });
    await quota.record429('claude', 'default', 30);
    const snapshot = buildSnapshot(store, gates, undefined, quota);
    expect(snapshot.quota[0]?.cooldown_until).not.toBeNull();
    expect(snapshot.quota[0]?.remaining_fraction).toBe(0);
  });

  test('carries spend_usd for a Pi-on-Claude extra-usage account', async () => {
    const quota = new QuotaService({ store });
    await store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }, { id: 'pi', auth: 'subscription' }] } });
    await quota.recordReported('claude', 'pi', { remaining: 1, unit: 'fraction' }, { spendDeltaUsd: 2.5 });
    const snapshot = buildSnapshot(store, gates, undefined, quota);
    const pi = snapshot.quota.find((q) => q.account === 'pi');
    expect(pi?.spend_usd).toBe(2.5);
  });
});
