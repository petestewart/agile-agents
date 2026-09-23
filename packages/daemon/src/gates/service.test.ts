import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Policy } from '@agile-agents/shared';
import { ulid, validateAgentMessage } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import {
  EmptyNoteError,
  GateAlreadyConsumedError,
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
  return { decision: 'deny', by: 'human', rationale: 'test delegate' };
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

/** T121: every gate is raised on a stream; this suite only needs a stable id. */
const STREAM = ulid();

function ctx(gates: Policy['gates'], extra: Record<string, unknown> = {}) {
  return { policy: policy(gates), stream: STREAM, ...extra };
}

describe('GateService.request', () => {
  test('a human-owned gate opens pending with no deadline, and writes no bus message', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('land', ctx({ land: 'human' }));
    expect(req.owner).toBe('human');
    expect(req.status).toBe('pending');
    expect(req.deadline).toBeUndefined();
    // The inbox reads `gates/`; T168 deleted the dead `bus/inbox/human` copy.
    expect(store.listEntities('bus/inbox/human', (v) => v)).toHaveLength(0);
  });

  test('a delegate never decides a plain human gate at request time', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    const req = await service.request('land', ctx({ land: 'human' }));
    expect(req.status).toBe('pending');
  });

  test('the old em/architect owners are rejected by the policy schema', async () => {
    const { validatePolicy } = await import('@agile-agents/shared');
    for (const owner of ['em', 'architect']) {
      expect(() => validatePolicy({ gates: { land: owner } })).toThrow();
    }
  });

  test('a human_timeout gate opens pending with a deadline derived from the duration', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('land', ctx({ land: 'human_timeout:1h' }));
    expect(req.status).toBe('pending');
    expect(req.deadline).toBe(new Date(now.getTime() + 3_600_000).toISOString());
  });

  // T121: the gate name is a closed set, so "unknown gate" now means "no
  // policy row names an owner for one of the three" — it still fails safe.
  test('a gate with no policy row defaults to human', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('rule_accept', ctx({}));
    expect(req.owner).toBe('human');
    expect(req.status).toBe('pending');
    expect(req.stream).toBe(STREAM);
    expect(req.hil_kind).toBe('rule_accept');
  });

  test('raising one mints a gate_raised event carrying the stream', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('land', ctx({ land: 'human' }));
    const event = store.listEvents().find((e) => e.kind === 'gate_raised');
    expect(event?.stream).toBe(STREAM);
    expect(event?.data).toMatchObject({ id: req.id, gate: 'land' });
  });
});

describe('GateService.respond', () => {
  test('resolves a pending request with a decision and who decided it', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('land', ctx({ land: 'human' }));
    const resolved = await service.respond(req.id, 'approve', 'human');
    expect(resolved.status).toBe('resolved');
    expect(resolved.decision).toBe('approve');
    expect(resolved.decided_by).toBe('human');
    expect(resolved.deadline).toBeUndefined();
  });

  test('refuses to respond twice', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('land', ctx({ land: 'human' }));
    await service.respond(req.id, 'approve', 'human');
    await expect(service.respond(req.id, 'deny', 'human')).rejects.toThrow(
      GateAlreadyResolvedError,
    );
  });

  test('an unknown id throws', async () => {
    const service = new GateService(store, { clock });
    await expect(service.respond('HIL-nope', 'approve', 'human')).rejects.toThrow(
      GateNotFoundError,
    );
  });
});

// T039 (§17 "Control room v2"): every Needs-you card takes a typed answer as
// well as its buttons.

describe('GateService note delivery', () => {
  const WAITING = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  test('a noted answer is delivered to the session waiting on the gate, and to nobody else', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('land', ctx({ land: 'human' }, { requestedBy: WAITING }));
    await service.respond(req.id, 'deny', 'human', 'not on a shared branch');
    const inbox = store.listEntities(`bus/inbox/${WAITING}`, validateAgentMessage);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: 'hil_response', priority: 'normal', from: 'human' });
    expect(inbox[0]?.body).toContain('was denied by human');
    expect(inbox[0]?.body).toContain('not on a shared branch');
    expect(store.listEntities('bus/inbox', (v) => v)).toHaveLength(0);
  });

  test('a note with no decision stays on the record and hands the gate to the delegate', async () => {
    let resolveDecision!: (d: GateDecision) => void;
    const deciding = new Promise<GateDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const service = new GateService(store, { clock, delegate: () => deciding });
    const req = await service.request('land', ctx({ land: 'human' }, { requestedBy: WAITING }));
    const noted = await service.addNote(req.id, 'only the seed script', 'human');
    expect(noted.status).toBe('pending');
    expect(store.listEntities(`bus/inbox/${WAITING}`, validateAgentMessage)).toHaveLength(0);

    resolveDecision({ decision: 'approve', by: 'human', rationale: 'seed only' });
    await service.settled();
    const after = service.get(req.id);
    expect(after).toMatchObject({ status: 'resolved', decision: 'approve', delegated: true });
    expect(after.fyi?.body).toContain('seed only');
    expect(store.listEntities(`bus/inbox/${WAITING}`, validateAgentMessage)).toHaveLength(1);
  });

  test('an async delegate that rejects fails closed: denied, with the failure as rationale', async () => {
    const service = new GateService(store, {
      clock,
      delegate: async () => {
        throw new Error('delegate timed out');
      },
    });
    const req = await service.request('land', ctx({ land: 'human' }));
    await service.addNote(req.id, 'go ahead', 'human');
    await service.settled();
    const after = service.get(req.id);
    expect(after.decision).toBe('deny');
    expect(after.fyi?.body).toContain('delegate timed out');
  });

  test('a human answer that lands before the async delegate wins; the late decision is dropped', async () => {
    let resolveDecision!: (d: GateDecision) => void;
    const deciding = new Promise<GateDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const service = new GateService(store, { clock, delegate: () => deciding });
    const req = await service.request('land', ctx({ land: 'human' }));
    await service.addNote(req.id, 'maybe', 'human');
    await service.respond(req.id, 'deny', 'human');
    resolveDecision({ decision: 'approve', by: 'human' });
    await service.settled();
    const after = service.get(req.id);
    expect(after.decision).toBe('deny');
    expect(after.delegated).toBeUndefined();
  });
});

describe('GateService.tick (human_timeout fallthrough)', () => {
  test('does not fall through before the deadline', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    const req = await service.request('land', ctx({ land: 'human_timeout:1h' }));
    advance(3_599_999); // one ms short of 1h
    const fallenThrough = await service.tick(now);
    expect(fallenThrough).toHaveLength(0);
    expect(service.get(req.id).status).toBe('pending');
  });

  test('falls through exactly at the deadline', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    const req = await service.request('land', ctx({ land: 'human_timeout:1h' }));
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
    const service = new GateService(store, { clock, delegate: denyDelegate });
    const req = await service.request('land', ctx({ land: 'human' }));
    advance(10_000_000);
    await service.tick(now);
    expect(service.get(req.id).status).toBe('pending');
  });

  test('without a configured delegate, a due human_timeout request stays pending with a reason, and is not reported as fallen through', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('land', ctx({ land: 'human_timeout:1h' }));
    advance(3_600_000);
    const fallenThrough = await service.tick(now);
    expect(fallenThrough).toHaveLength(0);
    const stillPending = service.get(req.id);
    expect(stillPending.status).toBe('pending');
    expect(stillPending.reason).toBe('no delegate configured');
  });

  test('survives a restart: a NEW GateService over the same store still falls through at the deadline', async () => {
    const first = new GateService(store, { clock });
    const req = await first.request('land', ctx({ land: 'human_timeout:1h' }));
    advance(3_600_000);

    // Simulate a daemon restart: a brand new GateService instance, no shared in-memory state.
    const second = new GateService(store, { clock, delegate: denyDelegate });
    const fallenThrough = await second.tick(now);
    expect(fallenThrough.map((r) => r.id)).toContain(req.id);
    expect(second.get(req.id).status).toBe('resolved');
  });
});

describe('circuit breaker', () => {
  test('tripping a signal forces even a human_timeout gate to plain human, and the request names the signal', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    await service.trip('integration_red', 'nightly integration suite is failing');
    const req = await service.request(
      'classifier_review',
      ctx({ classifier_review: 'human_timeout:1h' }),
    );
    expect(req.owner).toBe('human');
    expect(req.status).toBe('pending');
    expect(req.reason).toContain('integration_red');
  });

  test('clearing the signal restores normal resolution', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    await service.trip('deadlock', 'worker vs reviewer');
    await service.clear('deadlock');
    const req = await service.request(
      'classifier_review',
      ctx({ classifier_review: 'human_timeout:1h' }),
    );
    expect(req.owner).toBe('human_timeout:1h');
    expect(req.deadline).toBeDefined();
    expect(req.reason).toBeUndefined();
  });

  test('multiple tripped signals are all named in the reason', async () => {
    const service = new GateService(store, { clock });
    await service.trip('budget_pct', 'over 90% of budget');
    await service.trip('ladder_exhausted', 'TKT-0231 exhausted escalation');
    const req = await service.request('land', ctx({ land: 'human' }));
    expect(req.reason).toContain('budget_pct');
    expect(req.reason).toContain('ladder_exhausted');
  });
});

describe('GateService.list', () => {
  test('lists every request created so far, read fresh from disk (durable across instances)', async () => {
    const service = new GateService(store, { clock });
    const a = await service.request('land', ctx({ land: 'human' }));
    const b = await service.request('classifier_review', ctx({ classifier_review: 'human' }));

    const fresh = new GateService(store, { clock });
    const ids = fresh.list().map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });
});

describe('GateService.consume (T151 — compare-and-swap)', () => {
  test('two identical in-flight calls cannot both be allowed by one approval', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('classifier_review', ctx({ classifier_review: 'human' }));
    await service.respond(req.id, 'approve', 'human');

    // Both read the same approved-and-unconsumed record, then both try to
    // spend it — the loser must be told, not silently waved through.
    const [first, second] = await Promise.allSettled([
      service.consume(req.id),
      service.consume(req.id),
    ]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(service.get(req.id).consumed_at).toBeDefined();
  });

  test('a later consume of a spent approval rejects rather than returning it', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('classifier_review', ctx({ classifier_review: 'human' }));
    await service.respond(req.id, 'approve', 'human');
    await service.consume(req.id);

    expect(service.consume(req.id)).rejects.toThrow(GateAlreadyConsumedError);
  });
});
