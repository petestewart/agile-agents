import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Policy } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import {
  EmptyNoteError,
  GateAlreadyResolvedError,
  type GateDecision,
  GateNotFoundError,
  GateService,
  NoDelegateConfiguredError,
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

function ctx(gates: Policy['gates'], extra: Record<string, unknown> = {}) {
  return { policy: policy(gates), hilKind: 'unblock' as const, ...extra };
}

describe('GateService.request', () => {
  test('a human-owned gate opens pending with no deadline, and writes an urgent hil_request bus message', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('sprint_review', ctx({ sprint_review: 'human' }));
    expect(req.owner).toBe('human');
    expect(req.status).toBe('pending');
    expect(req.deadline).toBeUndefined();

    const inbox = store.listEntities(
      'bus/inbox/human',
      (v) => v as { kind: string; priority: string },
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.kind).toBe('hil_request');
    expect(inbox[0]?.priority).toBe('urgent');
  });

  test('an em-owned gate with a delegate is auto-decided immediately and produces a decision artifact + fyi message', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    const req = await service.request('unblock', ctx({ unblock: 'em' }));
    expect(req.status).toBe('resolved');
    expect(req.delegated).toBe(true);
    expect(req.decision).toBe('deny');
    expect(req.decided_by).toBe('architect');
    expect(req.fyi?.to).toBe('human');
    expect(req.fyi?.body).toContain('unblock');
    expect(req.deadline).toBeUndefined();

    // The decision artifact is durable, not just in-memory.
    const reloaded = store.getEntity(`board/hil/${req.id}.yaml`, (v) => v as typeof req);
    expect(reloaded.status).toBe('resolved');

    const inbox = store.listEntities(
      'bus/inbox/human',
      (v) => v as { kind: string; priority: string },
    );
    expect(inbox.some((m) => m.kind === 'fyi' && m.priority === 'low')).toBe(true);
  });

  test('an ASYNC delegate leaves the request pending ("delegate deciding") and resolves it when the promise settles', async () => {
    // The EM-session delegate (`em/delegate.ts`) takes a model turn; the
    // hook that raised the request cannot wait on it.
    let resolveDecision!: (d: GateDecision) => void;
    const deciding = new Promise<GateDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const service = new GateService(store, { clock, delegate: () => deciding });
    const req = await service.request(
      'unblock',
      ctx(
        { unblock: 'em' },
        {
          ticket: 'TKT-0001',
          summary: 'eng-0001 asked to run `git push origin main`',
        },
      ) as never,
    );
    expect(req.status).toBe('pending');
    expect(req.reason).toBe('delegate deciding');
    expect(req.summary).toBe('eng-0001 asked to run `git push origin main`');

    resolveDecision({ decision: 'approve', by: 'em', rationale: 'ticket branch only' });
    await service.settled();
    const after = service.get(req.id);
    expect(after.status).toBe('resolved');
    expect(after.decision).toBe('approve');
    expect(after.decided_by).toBe('em');
    expect(after.delegated).toBe(true);
    expect(after.reason).toBeUndefined();
    expect(after.fyi?.body).toContain('ticket branch only');
  });

  test('an async delegate that rejects fails closed: denied, with the failure as rationale', async () => {
    const service = new GateService(store, {
      clock,
      delegate: async () => {
        throw new Error('EM session timed out');
      },
    });
    const req = await service.request('unblock', ctx({ unblock: 'em' }));
    expect(req.status).toBe('pending');
    await service.settled();
    const after = service.get(req.id);
    expect(after.status).toBe('resolved');
    expect(after.decision).toBe('deny');
    expect(after.fyi?.body).toContain('EM session timed out');
  });

  test('a human answer that lands before the async delegate wins; the late decision is dropped', async () => {
    let resolveDecision!: (d: GateDecision) => void;
    const deciding = new Promise<GateDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const service = new GateService(store, { clock, delegate: () => deciding });
    const req = await service.request('unblock', ctx({ unblock: 'em' }));
    await service.respond(req.id, 'deny', 'human');
    resolveDecision({ decision: 'approve', by: 'em' });
    await service.settled();
    const after = service.get(req.id);
    expect(after.decision).toBe('deny');
    expect(after.decided_by).toBe('human');
  });

  test('an em-owned gate with NO delegate configured stays pending (fail closed, never auto-approves)', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('unblock', ctx({ unblock: 'em' }));
    expect(req.status).toBe('pending');
    expect(req.decision).toBeUndefined();
    expect(req.reason).toBe('no delegate configured');

    // It is still listed for the human, via a hil_request message.
    const inbox = store.listEntities('bus/inbox/human', (v) => v as { kind: string });
    expect(inbox.some((m) => m.kind === 'hil_request')).toBe(true);
  });

  test('a human_timeout gate opens pending with a deadline derived from the duration', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('demo', ctx({ demo: 'human_timeout:1h' }));
    expect(req.status).toBe('pending');
    expect(req.deadline).toBe(new Date(now.getTime() + 3_600_000).toISOString());
  });

  test('an unknown gate defaults to human', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('no_such_gate', ctx({}));
    expect(req.owner).toBe('human');
    expect(req.status).toBe('pending');
  });
});

describe('GateService.respond', () => {
  test('resolves a pending request with a decision and who decided it', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('demo', ctx({ demo: 'human' }));
    const resolved = await service.respond(req.id, 'approve', 'human');
    expect(resolved.status).toBe('resolved');
    expect(resolved.decision).toBe('approve');
    expect(resolved.decided_by).toBe('human');
    expect(resolved.deadline).toBeUndefined();
  });

  test('refuses to respond twice', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('demo', ctx({ demo: 'human' }));
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
describe('GateService notes', () => {
  async function seedTicket(): Promise<void> {
    await store.putTicket(
      validateTicket({
        id: 'TKT-0001',
        title: 'Ticket',
        status: 'in_progress',
        contract: {},
        history: [],
        assignee: 'eng-1',
      }),
    );
  }

  test('respond() persists the note, logs it, and delivers it to the waiting agent and the EM', async () => {
    await seedTicket();
    const service = new GateService(store, { clock });
    const req = await service.request('unblock', ctx({ unblock: 'human' }, { ticket: 'TKT-0001' }));
    const resolved = await service.respond(
      req.id,
      'approve',
      'human',
      '  yes, but only for the seed script  ',
    );
    expect(resolved.note).toBe('yes, but only for the seed script'); // trimmed
    expect(service.get(req.id).note).toBe('yes, but only for the seed script'); // durable

    const engInbox = store.listEntities(
      'bus/inbox/eng-1',
      (v) => v as { kind: string; priority: string; body: string },
    );
    expect(engInbox).toHaveLength(1);
    expect(engInbox[0]?.kind).toBe('hil_response');
    expect(engInbox[0]?.priority).toBe('normal');
    expect(engInbox[0]?.body).toContain('only for the seed script');

    const emInbox = store.listEntities('bus/inbox/em', (v) => v as { body: string });
    expect(emInbox).toHaveLength(1);
    expect(emInbox[0]?.body).toContain('only for the seed script');

    const event = store.listEvents().find((e) => e.kind === 'hil_resolved');
    expect(event?.data.note).toBe('yes, but only for the seed script');
  });

  test('respond() with no note writes no hil_response and leaves note unset', async () => {
    await seedTicket();
    const service = new GateService(store, { clock });
    const req = await service.request('unblock', ctx({ unblock: 'human' }, { ticket: 'TKT-0001' }));
    const resolved = await service.respond(req.id, 'approve', 'human', '   ');
    expect(resolved.note).toBeUndefined();
    expect(store.listEntities('bus/inbox/eng-1', (v) => v)).toHaveLength(0);
  });

  test('addNote() records the note WITHOUT resolving the gate, and copies the EM', async () => {
    await seedTicket();
    const service = new GateService(store, { clock });
    const req = await service.request('unblock', ctx({ unblock: 'human' }, { ticket: 'TKT-0001' }));
    const noted = await service.addNote(req.id, 'only for the seed script', 'human');
    expect(noted.status).toBe('pending');
    expect(noted.decision).toBeUndefined();
    expect(noted.note).toBe('only for the seed script');

    const emInbox = store.listEntities('bus/inbox/em', (v) => v as { kind: string; body: string });
    expect(emInbox).toHaveLength(1);
    expect(emInbox[0]?.kind).toBe('hil_response');
    // Nothing is delivered to the engineer yet — there is no decision to deliver.
    expect(store.listEntities('bus/inbox/eng-1', (v) => v)).toHaveLength(0);
  });

  test('addNote() hands the note to the delegate, whose decision then resolves the gate', async () => {
    await seedTicket();
    const seen: Array<string | undefined> = [];
    const service = new GateService(store, {
      clock,
      delegate: (c) => {
        seen.push(c.note);
        return { decision: 'approve', by: 'em', rationale: 'scoped to the seed script' };
      },
    });
    const req = await service.request('unblock', ctx({ unblock: 'human' }, { ticket: 'TKT-0001' }));
    expect(service.get(req.id).status).toBe('pending');
    await service.addNote(req.id, 'only for the seed script', 'human');
    await service.settled();

    expect(seen).toEqual(['only for the seed script']);
    const after = service.get(req.id);
    expect(after.status).toBe('resolved');
    expect(after.decision).toBe('approve');
    expect(after.note).toBe('only for the seed script');
  });

  test('addNote() rejects an empty note and a resolved request', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('demo', ctx({ demo: 'human' }));
    await expect(service.addNote(req.id, '   ', 'human')).rejects.toThrow(EmptyNoteError);
    await service.respond(req.id, 'approve', 'human');
    await expect(service.addNote(req.id, 'late', 'human')).rejects.toThrow(
      GateAlreadyResolvedError,
    );
  });
});

describe('GateService.delegateRequest (single-instance delegation)', () => {
  test('delegates a pending human-owned request, producing the same artifact shape + fyi', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    const req = await service.request('demo', ctx({ demo: 'human' }));
    const delegated = await service.delegateRequest(req.id, 'architect');
    expect(delegated.status).toBe('resolved');
    expect(delegated.delegated).toBe(true);
    expect(delegated.decision).toBe('deny');
    expect(delegated.fyi?.body).toContain('demo');
  });

  test('a second delegate call on the same request is refused (single-instance)', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    const req = await service.request('demo', ctx({ demo: 'human' }));
    await service.delegateRequest(req.id, 'em');
    await expect(service.delegateRequest(req.id, 'architect')).rejects.toThrow(
      GateAlreadyResolvedError,
    );
  });

  test('refuses to delegate without a configured delegate function', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('demo', ctx({ demo: 'human' }));
    await expect(service.delegateRequest(req.id, 'em')).rejects.toThrow(NoDelegateConfiguredError);
  });
});

describe('GateService.tick (human_timeout fallthrough)', () => {
  test('does not fall through before the deadline', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    const req = await service.request('demo', ctx({ demo: 'human_timeout:1h' }));
    advance(3_599_999); // one ms short of 1h
    const fallenThrough = await service.tick(now);
    expect(fallenThrough).toHaveLength(0);
    expect(service.get(req.id).status).toBe('pending');
  });

  test('falls through exactly at the deadline', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    const req = await service.request('demo', ctx({ demo: 'human_timeout:1h' }));
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
    const req = await service.request('demo', ctx({ demo: 'human' }));
    advance(10_000_000);
    await service.tick(now);
    expect(service.get(req.id).status).toBe('pending');
  });

  test('without a configured delegate, a due human_timeout request stays pending with a reason, and is not reported as fallen through', async () => {
    const service = new GateService(store, { clock });
    const req = await service.request('demo', ctx({ demo: 'human_timeout:1h' }));
    advance(3_600_000);
    const fallenThrough = await service.tick(now);
    expect(fallenThrough).toHaveLength(0);
    const stillPending = service.get(req.id);
    expect(stillPending.status).toBe('pending');
    expect(stillPending.reason).toBe('no delegate configured');
  });

  test('survives a restart: a NEW GateService over the same store still falls through at the deadline', async () => {
    const first = new GateService(store, { clock });
    const req = await first.request('demo', ctx({ demo: 'human_timeout:1h' }));
    advance(3_600_000);

    // Simulate a daemon restart: a brand new GateService instance, no shared in-memory state.
    const second = new GateService(store, { clock, delegate: denyDelegate });
    const fallenThrough = await second.tick(now);
    expect(fallenThrough.map((r) => r.id)).toContain(req.id);
    expect(second.get(req.id).status).toBe('resolved');
  });
});

describe('circuit breaker', () => {
  test('tripping a signal forces even a delegated gate to human, and the request names the signal', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    await service.trip('integration_red', 'nightly integration suite is failing');
    const req = await service.request('unblock', ctx({ unblock: 'em' }));
    expect(req.owner).toBe('human');
    expect(req.status).toBe('pending');
    expect(req.reason).toContain('integration_red');
  });

  test('clearing the signal restores normal resolution', async () => {
    const service = new GateService(store, { clock, delegate: denyDelegate });
    await service.trip('deadlock', 'eng-3 vs reviewer-1');
    await service.clear('deadlock');
    const req = await service.request('unblock', ctx({ unblock: 'em' }));
    expect(req.owner).toBe('em');
    expect(req.status).toBe('resolved');
    expect(req.reason).toBeUndefined();
  });

  test('multiple tripped signals are all named in the reason', async () => {
    const service = new GateService(store, { clock });
    await service.trip('budget_pct', 'sprint over 90% of budget');
    await service.trip('ladder_exhausted', 'TKT-0231 exhausted escalation');
    const req = await service.request('demo', ctx({ demo: 'human' }));
    expect(req.reason).toContain('budget_pct');
    expect(req.reason).toContain('ladder_exhausted');
  });
});

describe('GateService.list', () => {
  test('lists every request created so far, read fresh from disk (durable across instances)', async () => {
    const service = new GateService(store, { clock });
    const a = await service.request('demo', ctx({ demo: 'human' }));
    const b = await service.request('unblock', ctx({ unblock: 'human' }));

    const fresh = new GateService(store, { clock });
    const ids = fresh.list().map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });
});
