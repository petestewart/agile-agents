import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OracleEntry, Ticket } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { createHalt } from '../halts';
import { runInit } from '../init';
import { StateStore } from '../store';
import { DiscoveryResolutionError, publishDecision, resolveDiscovery } from './decision';

let repo: string;
let store: StateStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-decision-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<OracleEntry> = {}): OracleEntry {
  return {
    id: 'DEC-0001',
    title: 'A decision',
    status: 'active',
    supersedes: [],
    depends: [],
    affects: [],
    decided: '2026-09-08',
    by: 'architect',
    rationale: 'because',
    ...overrides,
  };
}

function makeTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id,
    title: `Ticket ${id}`,
    status: 'ready',
    contract: {},
    oracle_refs: [],
    history: [],
    ...overrides,
  });
}

describe('publishDecision', () => {
  test('writes the entry as architect and ripples staled tickets', async () => {
    await store.putTicket(makeTicket('TKT-0001', { oracle_refs: ['DEC-0001'] }));
    const result = await publishDecision(store, makeEntry(), 'body');
    expect(result.entry.id).toBe('DEC-0001');
    expect(result.stale).toEqual(['TKT-0001']);
    expect(store.getTicket('TKT-0001').status).toBe('stale');
  });
});

describe('resolveDiscovery — quorum already reached', () => {
  test('publishes the decision and releases the named halt (no registered agents -> quorum vacuously reached)', async () => {
    const halt = await createHalt(store, {
      scope: 'global',
      reason: 'seeded contradiction',
      raised_by: 'architect',
      resolves_when: 'DEC-0001',
    });
    expect(halt.quorum).toBe('reached');
    const result = await resolveDiscovery(store, halt.id, makeEntry(), 'body');
    if (!result.released) throw new Error(`expected released: true, got ${result.reason}`);
    expect(result.oracle.entry.id).toBe('DEC-0001');
    expect(() => store.getHalt(halt.id)).toThrow();
  });

  test("refuses a decision id mismatched with the halt's resolves_when", async () => {
    const halt = await createHalt(store, {
      scope: 'global',
      reason: 'seeded contradiction',
      raised_by: 'architect',
      resolves_when: 'DEC-9999',
    });
    await expect(resolveDiscovery(store, halt.id, makeEntry(), 'body')).rejects.toThrow(
      DiscoveryResolutionError,
    );
    // Nothing touched — halt still active, decision unwritten.
    expect(() => store.getHalt(halt.id)).not.toThrow();
    expect(() => store.getOracleEntry('DEC-0001')).toThrow();
  });

  test('a halt with no resolves_when is resolved by any decision', async () => {
    const halt = await createHalt(store, {
      scope: 'global',
      reason: 'seeded contradiction',
      raised_by: 'architect',
    });
    const result = await resolveDiscovery(store, halt.id, makeEntry(), 'body');
    expect(result.released).toBe(true);
  });
});

/**
 * Independent review fix (opus blocker 3): §5's ceremony order is "reports
 * -> quorum -> decision -> release" — publishing/releasing must not jump
 * straight from "reports" to "decision" without quorum actually landing on
 * `reached` in between.
 */
describe('resolveDiscovery — quorum pending', () => {
  async function pendingHalt() {
    // A ticket with an assignee and no matching agent registration/report
    // yet — createHalt's `computeAffectedAgents` picks up `eng-1` via the
    // ticket's own `assignee` field, and quorum starts `pending` since
    // nobody has reported.
    await store.putTicket(makeTicket('TKT-0001', { status: 'in_progress', assignee: 'eng-1' }));
    return createHalt(store, {
      scope: ['TKT-0001'],
      reason: 'seeded contradiction',
      raised_by: 'architect',
    });
  }

  test('refuses to release: nothing published, halt left untouched', async () => {
    const halt = await pendingHalt();
    expect(halt.quorum).toBe('pending');

    const result = await resolveDiscovery(store, halt.id, makeEntry(), 'body');
    if (result.released) throw new Error('expected released: false');
    expect(result.reason).toMatch(/quorum/i);
    expect(result.halt.id).toBe(halt.id);

    // Nothing written: halt still active, no decision on record.
    expect(() => store.getHalt(halt.id)).not.toThrow();
    expect(() => store.getOracleEntry('DEC-0001')).toThrow();
  });

  test('force: true bypasses the quorum check and logs the override', async () => {
    const halt = await pendingHalt();
    const result = await resolveDiscovery(store, halt.id, makeEntry(), 'body', {
      force: true,
      forcedBy: 'em',
    });
    if (!result.released) throw new Error(`expected released: true, got ${result.reason}`);
    expect(result.oracle.entry.id).toBe('DEC-0001');
    expect(() => store.getHalt(halt.id)).toThrow();

    const forcedEvent = store
      .listEvents()
      .find(
        (e) =>
          e.kind === 'halt_updated' &&
          (e.data as { forced_release?: boolean }).forced_release === true,
      );
    expect(forcedEvent).toBeDefined();
    expect((forcedEvent?.data as { by?: string }).by).toBe('em');
  });

  test('force defaults forcedBy to "em" when not given', async () => {
    const halt = await pendingHalt();
    const result = await resolveDiscovery(store, halt.id, makeEntry(), 'body', { force: true });
    expect(result.released).toBe(true);
    const forcedEvent = store
      .listEvents()
      .find(
        (e) => e.kind === 'halt_updated' && (e.data as { forced_release?: boolean }).forced_release,
      );
    expect((forcedEvent?.data as { by?: string }).by).toBe('em');
  });
});
