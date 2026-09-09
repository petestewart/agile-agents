import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HilRequest, Policy } from '@agile-agents/shared';
import { runInit } from '../init';
import { dispatch } from '../rpc';
import { StateStore } from '../store';
import { buildGateRpcMethods } from './rpc';
import { GateService } from './service';

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
  service = new GateService(store, { delegate: () => ({ decision: 'approve', by: 'em' }) });
  methods = buildGateRpcMethods(service);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function policy(gates: Policy['gates']): Policy {
  return { gates, breaker_signals: [] };
}

function ctx(gates: Policy['gates']) {
  return { policy: policy(gates), hilKind: 'unblock' as const };
}

function resultOf(response: Awaited<ReturnType<typeof dispatch>>): unknown {
  return response && 'result' in response ? response.result : undefined;
}

function errorOf(response: Awaited<ReturnType<typeof dispatch>>) {
  return response && 'error' in response ? response.error : undefined;
}

describe('gate.* RPC round trip (via dispatch) — happy paths', () => {
  test('gate.list surfaces a pending request created directly on the service', async () => {
    const req = await service.request('demo', ctx({ demo: 'human' }));

    const listResponse = await dispatch(methods, { jsonrpc: '2.0', id: 1, method: 'gate.list' });
    expect(resultOf(listResponse)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: req.id, status: 'pending' })]),
    );

    const approveResponse = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 2,
      method: 'gate.approve',
      params: { id: req.id, by: 'human' },
    });
    const approved = resultOf(approveResponse) as HilRequest | undefined;
    expect(approved?.status).toBe('resolved');
    expect(approved?.decision).toBe('approve');
    expect(approved?.decided_by).toBe('human');

    const listAfter = await dispatch(methods, { jsonrpc: '2.0', id: 3, method: 'gate.list' });
    const after = resultOf(listAfter) as HilRequest[];
    expect(after.find((r) => r.id === req.id)?.status).toBe('resolved');
  });

  test('gate.delegate resolves a pending request via the single-instance path', async () => {
    const req = await service.request('unblock', ctx({ unblock: 'human' }));
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.delegate',
      params: { id: req.id, to: 'em' },
    });
    const result = resultOf(response) as HilRequest | undefined;
    expect(result?.status).toBe('resolved');
    expect(result?.delegated).toBe(true);
  });

  test('gate.breaker_clear via RPC restores normal gate resolution', async () => {
    await service.trip('global_halt', 'H-1 raised, everyone stop');
    const tripped = await service.request('demo', ctx({ demo: 'human' }));
    expect(tripped.reason).toContain('global_halt');

    const clearResponse = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.breaker_clear',
      params: { signal: 'global_halt' },
    });
    expect(errorOf(clearResponse)).toBeUndefined();

    const afterClear = await service.request('demo', ctx({ demo: 'human' }));
    expect(afterClear.reason).toBeUndefined();
  });

  test('gate.resolve is the generic decision endpoint (approve or deny)', async () => {
    const req = await service.request('demo', ctx({ demo: 'human' }));
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.resolve',
      params: { id: req.id, decision: 'deny', by: 'human' },
    });
    const result = resultOf(response) as HilRequest | undefined;
    expect(result?.status).toBe('resolved');
    expect(result?.decision).toBe('deny');
  });
});

describe('gate.* RPC round trip — negative paths (finding 5)', () => {
  test('gate.approve with missing params returns a structured error, not a crash', async () => {
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.approve',
      params: null,
    });
    expect(response).toBeDefined();
    const error = errorOf(response);
    expect(error).toBeDefined();
    expect(error?.message).toContain('object');
  });

  test('gate.approve with a malformed id is rejected before touching the service', async () => {
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.approve',
      params: { id: 'not-a-hil-id', by: 'human' },
    });
    const error = errorOf(response);
    expect(error?.message).toContain('id');
    // No request was created/mutated as a side effect.
    expect(service.list()).toHaveLength(0);
  });

  test('gate.resolve with an illegal decision value is rejected', async () => {
    const req = await service.request('demo', ctx({ demo: 'human' }));
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.resolve',
      params: { id: req.id, decision: 'maybe', by: 'human' },
    });
    const error = errorOf(response);
    expect(error?.message).toContain('decision');
    // Still pending — the bad request never reached GateService.respond.
    expect(service.get(req.id).status).toBe('pending');
  });

  test('gate.breaker_clear with an unknown signal is rejected and trips nothing', async () => {
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.breaker_clear',
      params: { signal: 'not_a_real_signal' },
    });
    const error = errorOf(response);
    expect(error?.message).toContain('signal');
  });

  test('gate.delegate with an unknown id surfaces a not-found error', async () => {
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.delegate',
      params: { id: 'HIL-01ARZ3NDEKTSV4RRFFQ69G5FAV', to: 'em' },
    });
    const error = errorOf(response);
    expect(error?.message).toContain('not found');
  });

  test('gate.delegate with an invalid "to" is rejected', async () => {
    const req = await service.request('demo', ctx({ demo: 'human' }));
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.delegate',
      params: { id: req.id, to: 'reviewer' },
    });
    const error = errorOf(response);
    expect(error?.message).toContain('to');
    expect(service.get(req.id).status).toBe('pending');
  });
});
