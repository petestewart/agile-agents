import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Policy } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import {
  GateAlreadyResolvedError,
  type GateDecision,
  GateNotFoundError,
  GateService,
} from './service';

let repo: string;
let store: StateStore;
let now: Date;

function clock(): Date {
  return now;
}

function advance(ms: number): void {
  now = new Date(now.getTime() + ms);
}

/** A delegate that always denies, so tests can tell "auto-decided" apart from the default. */
function denyDelegate(): GateDecision {
  return { decision: 'deny', by: 'architect', rationale: 'test delegate' };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-gates-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  now = new Date('2026-01-01T00:00:00.000Z');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function policy(gates: Policy['gates']): Policy {
  return { gates, breaker_signals: [] };
}

describe('GateService.request', () => {
  test('a human-owned gate opens pending with no deadline', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('sprint_review', {
      policy: policy({ sprint_review: 'human' }),
    });
    expect(req.owner).toBe('human');
    expect(req.status).toBe('pending');
    expect(req.deadline).toBeUndefined();
  });

  test('an em-owned gate is auto-decided immediately and produces a decision artifact + fyi', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    const req = await service.request('unblock', { policy: policy({ unblock: 'em' }) });
    expect(req.status).toBe('resolved');
    expect(req.delegated).toBe(true);
    expect(req.decision).toBe('deny');
    expect(req.decided_by).toBe('architect');
    expect(req.fyi?.to).toBe('human');
    expect(req.fyi?.body).toContain('unblock');

    // The decision artifact is durable, not just in-memory.
    const reloaded = store.getEntity(`board/hil/${req.id}.yaml`, (v) => v as typeof req);
    expect(reloaded.status).toBe('resolved');
  });

  test('a human_timeout gate opens pending with a deadline derived from the duration', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('demo', { policy: policy({ demo: 'human_timeout:1h' }) });
    expect(req.status).toBe('pending');
    expect(req.deadline).toBe(new Date(now.getTime() + 3_600_000).toISOString());
  });

  test('an unknown gate defaults to human', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('no_such_gate', { policy: policy({}) });
    expect(req.owner).toBe('human');
    expect(req.status).toBe('pending');
  });
});

describe('GateService.respond', () => {
  test('resolves a pending request with a decision and who decided it', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('demo', { policy: policy({ demo: 'human' }) });
    const resolved = await service.respond(req.id, 'approve', 'human');
    expect(resolved.status).toBe('resolved');
    expect(resolved.decision).toBe('approve');
    expect(resolved.decided_by).toBe('human');
  });

  test('refuses to respond twice', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('demo', { policy: policy({ demo: 'human' }) });
    await service.respond(req.id, 'approve', 'human');
    await expect(service.respond(req.id, 'deny', 'human')).rejects.toThrow(
      GateAlreadyResolvedError,
    );
  });

  test('an unknown id throws', async () => {
    const service = new GateService(store, { clock });
    await expect(service.respond('hil_nope', 'approve', 'human')).rejects.toThrow(
      GateNotFoundError,
    );
  });
});

describe('GateService.delegateRequest (single-instance delegation)', () => {
  test('delegates a pending human-owned request, producing the same artifact shape + fyi', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    const req = await service.request('demo', { policy: policy({ demo: 'human' }) });
    const delegated = await service.delegateRequest(req.id, 'architect');
    expect(delegated.status).toBe('resolved');
    expect(delegated.delegated).toBe(true);
    expect(delegated.decision).toBe('deny');
    expect(delegated.fyi?.body).toContain('demo');
  });

  test('a second delegate call on the same request is refused (single-instance)', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('demo', { policy: policy({ demo: 'human' }) });
    await service.delegateRequest(req.id, 'em');
    await expect(service.delegateRequest(req.id, 'architect')).rejects.toThrow(
      GateAlreadyResolvedError,
    );
  });
});

describe('GateService.tick (human_timeout fallthrough)', () => {
  test('does not fall through before the deadline', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('demo', { policy: policy({ demo: 'human_timeout:1h' }) });
    advance(3_599_999); // one ms short of 1h
    const fallenThrough = await service.tick(now);
    expect(fallenThrough).toHaveLength(0);
    expect(service.get(req.id).status).toBe('pending');
  });

  test('falls through exactly at the deadline', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    const req = await service.request('demo', { policy: policy({ demo: 'human_timeout:1h' }) });
    advance(3_600_000); // exactly 1h
    const fallenThrough = await service.tick(now);
    expect(fallenThrough.map((r) => r.id)).toContain(req.id);
    const resolved = service.get(req.id);
    expect(resolved.status).toBe('resolved');
    expect(resolved.delegated).toBe(true);
    expect(resolved.decision).toBe('deny');
    expect(resolved.fyi).toBeDefined();
  });

  test('leaves a plain human-owned (non-timeout) request untouched', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('demo', { policy: policy({ demo: 'human' }) });
    advance(10_000_000);
    await service.tick(now);
    expect(service.get(req.id).status).toBe('pending');
  });
});

describe('circuit breaker', () => {
  test('tripping a signal forces even a delegated gate to human, and the request names the signal', async () => {
    const service = new GateService(store, { clock });
    await service.trip('integration_red', 'nightly integration suite is failing');
    const req = await service.request('unblock', { policy: policy({ unblock: 'em' }) });
    expect(req.owner).toBe('human');
    expect(req.status).toBe('pending');
    expect(req.reason).toContain('integration_red');
  });

  test('clearing the signal restores normal resolution', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    await service.trip('deadlock', 'eng-3 vs reviewer-1');
    await service.clear('deadlock');
    const req = await service.request('unblock', { policy: policy({ unblock: 'em' }) });
    expect(req.owner).toBe('em');
    expect(req.status).toBe('resolved');
    expect(req.reason).toBeUndefined();
  });

  test('multiple tripped signals are all named in the reason', async () => {
    const service = new GateService(store, { clock });
    await service.trip('budget_pct', 'sprint over 90% of budget');
    await service.trip('ladder_exhausted', 'TKT-0231 exhausted escalation');
    const req = await service.request('demo', { policy: policy({ demo: 'human' }) });
    expect(req.reason).toContain('budget_pct');
    expect(req.reason).toContain('ladder_exhausted');
  });
});

describe('GateService.list', () => {
  test('lists every request created so far', async () => {
    const service = new GateService(store, { clock });
    const a = await service.request('demo', { policy: policy({ demo: 'human' }) });
    const b = await service.request('unblock', { policy: policy({ unblock: 'human' }) });
    const ids = service.list().map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });
});
