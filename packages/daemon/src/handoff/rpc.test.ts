import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { QuotaService } from '../quota/records';
import { dispatch } from '../rpc';
import { HandoffCoordinator } from './coordinator';
import { buildHandoffRpcMethods } from './rpc';
import { type HandoffFixture, fakeHandoffRunner, makeHandoffFixture } from './test-helpers';

let fx: HandoffFixture;
let methods: Record<string, ReturnType<typeof buildHandoffRpcMethods>[string]>;

beforeEach(async () => {
  fx = makeHandoffFixture();
  const runner = fakeHandoffRunner(fx.store);
  const quota = new QuotaService({ store: fx.store, bus: fx.bus });
  const coordinator = new HandoffCoordinator({
    store: fx.store,
    bus: fx.bus,
    runner,
    quota,
    repoRoot: fx.repo,
  });
  methods = buildHandoffRpcMethods(coordinator, fx.store);
  await fx.store.putVendors({ claude: { accounts: [{ id: 'default', auth: 'subscription' }] } });
});

afterEach(() => fx.cleanup());

async function call<T>(method: string, params?: unknown): Promise<T> {
  const response = await dispatch(methods, { jsonrpc: '2.0', id: 1, method, params });
  if (!response) throw new Error('no response');
  if ('error' in response) throw new Error(response.error.message);
  return response.result as T;
}

async function callErr(method: string, params?: unknown): Promise<string> {
  const response = await dispatch(methods, { jsonrpc: '2.0', id: 1, method, params });
  if (!response || !('error' in response)) throw new Error('expected an error response');
  return response.error.message;
}

describe('handoff.cooldown_set RPC — caller-identity check (QA round 1)', () => {
  test('rejects with no agent param at all', async () => {
    const message = await callErr('handoff.cooldown_set', {
      vendor: 'claude',
      account: 'default',
      until: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(message).toContain('"agent"');
  });

  test('rejects an engineer agent id — not em or human', async () => {
    const message = await callErr('handoff.cooldown_set', {
      agent: 'eng-1',
      vendor: 'claude',
      account: 'default',
      until: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(message).toContain('only em/human');
  });

  test('accepts em', async () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    const result = await call<{ cooldown_until: string }>('handoff.cooldown_set', {
      agent: 'em',
      vendor: 'claude',
      account: 'default',
      until,
    });
    expect(result.cooldown_until).toBe(until);
  });

  test('accepts human', async () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    const result = await call<{ cooldown_until: string }>('handoff.cooldown_set', {
      agent: 'human',
      vendor: 'claude',
      account: 'default',
      until,
    });
    expect(result.cooldown_until).toBe(until);
  });
});

describe('handoff.* RPC — other methods', () => {
  test('handoff.paused lists paused tickets', async () => {
    const result = await call<unknown[]>('handoff.paused');
    expect(result).toEqual([]);
  });
});

describe('handoff.tick RPC — caller-identity check (round 3, N-b)', () => {
  test('rejects with no agent param at all', async () => {
    const message = await callErr('handoff.tick', {});
    expect(message).toContain('"agent"');
  });

  test('rejects an engineer agent id', async () => {
    const message = await callErr('handoff.tick', { agent: 'eng-1' });
    expect(message).toContain('only em/human/daemon');
  });

  test('accepts em, human, and daemon', async () => {
    for (const agent of ['em', 'human', 'daemon']) {
      const result = await call<unknown>('handoff.tick', { agent });
      expect(result).toBeDefined();
    }
  });
});
