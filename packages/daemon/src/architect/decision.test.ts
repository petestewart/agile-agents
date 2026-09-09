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

describe('resolveDiscovery', () => {
  test('publishes the decision and releases the named halt', async () => {
    const halt = await createHalt(store, {
      scope: 'global',
      reason: 'seeded contradiction',
      raised_by: 'architect',
      resolves_when: 'DEC-0001',
    });
    const result = await resolveDiscovery(store, halt.id, makeEntry(), 'body');
    expect(result.released).toBe(true);
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
