import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OracleEntry, Ticket } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { OracleWriteRefusedError, oracleWrite, rippleWalk } from './index';

let repo: string;
let store: StateStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-oracle-'));
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
    decided: '2026-09-07',
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
    history: [],
    ...overrides,
  });
}

describe('oracleWrite — actor guard', () => {
  test('refuses a non-architect write', async () => {
    await expect(
      oracleWrite(store, { actor: 'eng-1', entry: makeEntry(), body: 'body' }),
    ).rejects.toThrow(OracleWriteRefusedError);
  });

  test('accepts an architect write', async () => {
    const result = await oracleWrite(store, {
      actor: 'architect',
      entry: makeEntry(),
      body: 'body',
    });
    expect(result.entry.id).toBe('DEC-0001');
    expect(store.listOracleIndex()['DEC-0001']).toBeDefined();
  });
});

describe('oracleWrite — graph validation', () => {
  test('refuses a dangling supersedes ref', async () => {
    await expect(
      oracleWrite(store, {
        actor: 'architect',
        entry: makeEntry({ supersedes: ['DEC-9999'] }),
        body: 'x',
      }),
    ).rejects.toThrow(/dangling/);
  });

  test('refuses a dangling depends ref', async () => {
    await expect(
      oracleWrite(store, {
        actor: 'architect',
        entry: makeEntry({ depends: ['SPEC-none-999'] }),
        body: 'x',
      }),
    ).rejects.toThrow(/dangling/);
  });

  test('refuses a dangling affects ref', async () => {
    await expect(
      oracleWrite(store, {
        actor: 'architect',
        entry: makeEntry({ affects: ['DEC-9999'] }),
        body: 'x',
      }),
    ).rejects.toThrow(/dangling/);
  });

  test('refuses self-supersede', async () => {
    await expect(
      oracleWrite(store, {
        actor: 'architect',
        entry: makeEntry({ id: 'DEC-0001', supersedes: ['DEC-0001'] }),
        body: 'x',
      }),
    ).rejects.toThrow(/may not supersede itself/);
  });

  test('refuses a cycle across depends/affects', async () => {
    await oracleWrite(store, {
      actor: 'architect',
      entry: makeEntry({ id: 'DEC-0001', affects: [] }),
      body: 'x',
    });
    await oracleWrite(store, {
      actor: 'architect',
      entry: makeEntry({ id: 'DEC-0002', depends: ['DEC-0001'] }),
      body: 'x',
    });
    // Closing the loop: DEC-0001 now affects DEC-0002, which depends on DEC-0001.
    await expect(
      oracleWrite(store, {
        actor: 'architect',
        entry: makeEntry({ id: 'DEC-0001', affects: ['DEC-0002'] }),
        body: 'x',
      }),
    ).rejects.toThrow(/cycle detected/);
  });

  test('happy path: writes entry, flips superseded, appends changelog, updates index', async () => {
    await oracleWrite(store, {
      actor: 'architect',
      entry: makeEntry({ id: 'DEC-0019', title: 'old' }),
      body: 'old body',
    });

    const result = await oracleWrite(store, {
      actor: 'architect',
      entry: makeEntry({ id: 'DEC-0042', title: 'new', supersedes: ['DEC-0019'] }),
      body: 'new body',
    });

    expect(result.superseded).toEqual(['DEC-0019']);
    expect(store.getOracleEntry('DEC-0019').entry.status).toBe('superseded');
    expect(store.listOracleIndex()['DEC-0019']).toBeUndefined();
    expect(store.listOracleIndex()['DEC-0042']).toBeDefined();
  });

  test('changelog.md gets a line for the write', async () => {
    await oracleWrite(store, {
      actor: 'architect',
      entry: makeEntry({ id: 'DEC-0050' }),
      body: 'x',
    });
    const changelogPath = join(repo, '.agile', 'oracle', 'changelog.md');
    const text = await Bun.file(changelogPath).text();
    expect(text).toContain('DEC-0050');
  });
});

describe('rippleWalk', () => {
  test('two-hop affects chain stales exactly the intersecting tickets, leaves others and done untouched', async () => {
    await oracleWrite(store, {
      actor: 'architect',
      entry: makeEntry({
        id: 'SPEC-foo-001',
        by: 'architect',
        title: 'spec',
      }),
      body: 'x',
    });
    await oracleWrite(store, {
      actor: 'architect',
      entry: makeEntry({ id: 'DEC-0002', affects: ['SPEC-foo-001'] }),
      body: 'x',
    });
    await oracleWrite(store, {
      actor: 'architect',
      entry: makeEntry({ id: 'DEC-0001', affects: ['DEC-0002'] }),
      body: 'x',
    });

    await store.putTicket(makeTicket('TKT-0001', { oracle_refs: ['SPEC-foo-001'] }));
    await store.putTicket(makeTicket('TKT-0002', { oracle_refs: ['DEC-0099'] }));
    await store.putTicket(
      makeTicket('TKT-0003', { oracle_refs: ['SPEC-foo-001'], status: 'done' }),
    );
    await store.putTicket(makeTicket('TKT-0004', { oracle_refs: ['DEC-0001'] }));

    const staled = await rippleWalk(store, 'DEC-0001');

    expect(staled.sort()).toEqual(['TKT-0001', 'TKT-0004']);
    expect(store.getTicket('TKT-0001').status).toBe('stale');
    expect(store.getTicket('TKT-0002').status).toBe('ready');
    expect(store.getTicket('TKT-0003').status).toBe('done');
    expect(store.getTicket('TKT-0004').status).toBe('stale');
  });

  test('a draft ticket cannot be marked stale (no legal transition)', async () => {
    await oracleWrite(store, {
      actor: 'architect',
      entry: makeEntry({ id: 'DEC-0001' }),
      body: 'x',
    });
    await store.putTicket(makeTicket('TKT-0001', { oracle_refs: ['DEC-0001'], status: 'draft' }));

    const staled = await rippleWalk(store, 'DEC-0001');
    expect(staled).toEqual([]);
    expect(store.getTicket('TKT-0001').status).toBe('draft');
  });
});
