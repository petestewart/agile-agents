import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Policy } from '@agile-agents/shared';
import { runInit } from '../init';
import { dispatch } from '../rpc';
import { StateStore } from '../store';
import { buildGateRpcMethods } from './rpc';
import { GateService } from './service';
import type { HilRequest } from './types';

let repo: string;
let store: StateStore;
let service: GateService;
let methods: Record<string, ReturnType<typeof buildGateRpcMethods>[string]>;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-gates-rpc-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  service = new GateService(store);
  methods = buildGateRpcMethods(service);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function policy(gates: Policy['gates']): Policy {
  return { gates, breaker_signals: [] };
}

describe('gate.* RPC round trip (via dispatch)', () => {
  test('gate.list surfaces a pending request created directly on the service', async () => {
    const req = await service.request('demo', { policy: policy({ demo: 'human' }) });

    const listResponse = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.list',
    });
    expect(listResponse && 'result' in listResponse ? listResponse.result : undefined).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: req.id, status: 'pending' })]),
    );

    const approveResponse = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 2,
      method: 'gate.approve',
      params: { id: req.id, by: 'human' },
    });
    const approved =
      approveResponse && 'result' in approveResponse
        ? (approveResponse.result as HilRequest)
        : undefined;
    expect(approved?.status).toBe('resolved');
    expect(approved?.decision).toBe('approve');
    expect(approved?.decided_by).toBe('human');

    // gate.list now reflects the resolution.
    const listAfter = await dispatch(methods, { jsonrpc: '2.0', id: 3, method: 'gate.list' });
    const after = listAfter && 'result' in listAfter ? (listAfter.result as HilRequest[]) : [];
    expect(after.find((r) => r.id === req.id)?.status).toBe('resolved');
  });

  test('gate.delegate resolves a pending request via the single-instance path', async () => {
    const req = await service.request('unblock', { policy: policy({ unblock: 'human' }) });
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.delegate',
      params: { id: req.id, to: 'em' },
    });
    const result = response && 'result' in response ? (response.result as HilRequest) : undefined;
    expect(result?.status).toBe('resolved');
    expect(result?.delegated).toBe(true);
  });

  test('gate.breaker_clear via RPC restores normal gate resolution', async () => {
    await service.trip('global_halt', 'H-1 raised, everyone stop');
    const tripped = await service.request('demo', { policy: policy({ demo: 'human' }) });
    expect(tripped.reason).toContain('global_halt');

    const clearResponse = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.breaker_clear',
      params: { signal: 'global_halt' },
    });
    expect(
      clearResponse && 'error' in clearResponse ? clearResponse.error : undefined,
    ).toBeUndefined();

    const afterClear = await service.request('demo', { policy: policy({ demo: 'human' }) });
    expect(afterClear.reason).toBeUndefined();
  });

  test('gate.resolve is the generic decision endpoint (approve or deny)', async () => {
    const req = await service.request('demo', { policy: policy({ demo: 'human' }) });
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.resolve',
      params: { id: req.id, decision: 'deny', by: 'human' },
    });
    const result = response && 'result' in response ? (response.result as HilRequest) : undefined;
    expect(result?.status).toBe('resolved');
    expect(result?.decision).toBe('deny');
  });
});
