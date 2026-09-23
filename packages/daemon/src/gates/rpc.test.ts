import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HilRequest, type Policy, ulid } from '@agile-agents/shared';
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
  service = new GateService(store, { delegate: () => ({ decision: 'approve', by: 'human' }) });
  methods = buildGateRpcMethods(service);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function policy(gates: Policy['gates']): Policy {
  return { gates, breaker_signals: [] };
}

/** T121: every gate is raised on a stream; this suite only needs a stable id. */
const STREAM = ulid();

function ctx(gates: Policy['gates']) {
  return { policy: policy(gates), stream: STREAM };
}

function resultOf(response: Awaited<ReturnType<typeof dispatch>>): unknown {
  return response && 'result' in response ? response.result : undefined;
}

function errorOf(response: Awaited<ReturnType<typeof dispatch>>) {
  return response && 'error' in response ? response.error : undefined;
}

// T039: free text on the decision, plus the note-only verb.
describe('gate.* RPC notes (T039)', () => {
  test('gate.approve carries a note onto the record', async () => {
    const req = await service.request('land', ctx({ land: 'human' }));
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.approve',
      params: { id: req.id, by: 'human', note: 'yes, but only for the seed script' },
    });
    expect(resultOf(response)).toEqual(
      expect.objectContaining({
        status: 'resolved',
        decision: 'approve',
        note: 'yes, but only for the seed script',
      }),
    );
  });

  test('gate.deny resolves with deny + note', async () => {
    const req = await service.request('land', ctx({ land: 'human' }));
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.deny',
      params: { id: req.id, by: 'human', note: 'not on a shared branch' },
    });
    expect(resultOf(response)).toEqual(
      expect.objectContaining({ decision: 'deny', note: 'not on a shared branch' }),
    );
  });

  test('gate.note stores the note without resolving', async () => {
    const req = await service.request('land', ctx({ land: 'human' }));
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.note',
      params: { id: req.id, note: 'only for the seed script', by: 'human' },
    });
    expect(resultOf(response)).toEqual(
      expect.objectContaining({ status: 'pending', note: 'only for the seed script' }),
    );
    expect((resultOf(response) as HilRequest).decision).toBeUndefined();
  });

  test('a non-string or over-long note is invalid params', async () => {
    const req = await service.request('land', ctx({ land: 'human' }));
    const bad = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.approve',
      params: { id: req.id, by: 'human', note: 42 },
    });
    expect(errorOf(bad)?.message).toMatch(/"note" must be a string/);

    const tooLong = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 2,
      method: 'gate.approve',
      params: { id: req.id, by: 'human', note: 'x'.repeat(801) },
    });
    expect(errorOf(tooLong)?.message).toMatch(/invalid "note"/);

    const missing = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 3,
      method: 'gate.note',
      params: { id: req.id, by: 'human' },
    });
    expect(errorOf(missing)?.message).toMatch(/"note" is required/);
  });
});

describe('gate.* RPC round trip (via dispatch) — happy paths', () => {
  test('gate.list surfaces a pending request created directly on the service', async () => {
    const req = await service.request('land', ctx({ land: 'human' }));

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

  test('gate.delegate is gone with the EM (T168)', async () => {
    expect(Object.keys(methods)).not.toContain('gate.delegate');
  });

  test('gate.breaker_clear via RPC restores normal gate resolution', async () => {
    await service.trip('global_halt', 'H-1 raised, everyone stop');
    const tripped = await service.request('land', ctx({ land: 'human' }));
    expect(tripped.reason).toContain('global_halt');

    const clearResponse = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 1,
      method: 'gate.breaker_clear',
      params: { signal: 'global_halt' },
    });
    expect(errorOf(clearResponse)).toBeUndefined();

    const afterClear = await service.request('land', ctx({ land: 'human' }));
    expect(afterClear.reason).toBeUndefined();
  });

  test('gate.resolve is the generic decision endpoint (approve or deny)', async () => {
    const req = await service.request('land', ctx({ land: 'human' }));
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
    const req = await service.request('land', ctx({ land: 'human' }));
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
});
