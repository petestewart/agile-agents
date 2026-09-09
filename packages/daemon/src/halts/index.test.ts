import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRecord, Ticket } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import {
  QUORUM_TIMEOUT_MS,
  activeHaltsFor,
  createHalt,
  recordStandupReport,
  releaseHalt,
} from './index';

let repo: string;
let stateRoot: string;
let store: StateStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-halts-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

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

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    vendor: 'claude',
    model: 'claude-sonnet-4-5',
    pid: 1234,
    last_seen: '2026-09-09T00:00:00Z',
    ...overrides,
  };
}

function fakeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('createHalt / releaseHalt', () => {
  test('creates a halt file with an auto-incrementing id, quorum pending until evaluated', async () => {
    await store.putTicket(makeTicket('TKT-0001'));
    const clock = fakeClock(0);
    const halt = await createHalt(
      store,
      { scope: ['TKT-0001'], reason: 'discovery', raised_by: 'architect' },
      clock.now,
    );
    expect(halt.id).toBe('H-1');
    // No agent assigned to TKT-0001 (no assignee, no registry record) -> vacuously reached.
    expect(halt.quorum).toBe('reached');
  });

  test('second halt gets the next id', async () => {
    const clock = fakeClock(0);
    const first = await createHalt(
      store,
      { scope: 'global', reason: 'a', raised_by: 'architect' },
      clock.now,
    );
    const second = await createHalt(
      store,
      { scope: 'global', reason: 'b', raised_by: 'architect' },
      clock.now,
    );
    expect(first.id).toBe('H-1');
    expect(second.id).toBe('H-2');
  });

  test('releaseHalt deletes the file', async () => {
    const clock = fakeClock(0);
    const halt = await createHalt(
      store,
      { scope: 'global', reason: 'x', raised_by: 'architect' },
      clock.now,
    );
    expect(store.listHalts().map((h) => h.id)).toContain(halt.id);
    await releaseHalt(store, halt.id);
    expect(store.listHalts().map((h) => h.id)).not.toContain(halt.id);
  });
});

describe('quorum', () => {
  test('reached when the last affected agent reports', async () => {
    await store.putTicket(makeTicket('TKT-0001', { assignee: undefined }));
    await store.putAgent('eng-1', makeAgent({ ticket: 'TKT-0001' }));
    await store.putAgent('eng-2', makeAgent({ ticket: 'TKT-0001' }));

    const clock = fakeClock(0);
    const halt = await createHalt(
      store,
      { scope: ['TKT-0001'], reason: 'discovery', raised_by: 'architect' },
      clock.now,
    );
    expect(halt.quorum).toBe('pending');

    const afterFirst = await recordStandupReport(store, halt.id, 'eng-1', clock.now);
    expect(afterFirst.quorum).toBe('pending');

    const afterSecond = await recordStandupReport(store, halt.id, 'eng-2', clock.now);
    expect(afterSecond.quorum).toBe('reached');
  });

  test('reached on timeout even if not every affected agent reported', async () => {
    await store.putAgent('eng-1', makeAgent({ ticket: 'TKT-0001' }));
    await store.putTicket(makeTicket('TKT-0001'));

    const clock = fakeClock(0);
    const halt = await createHalt(
      store,
      { scope: ['TKT-0001'], reason: 'discovery', raised_by: 'architect' },
      clock.now,
    );
    expect(halt.quorum).toBe('pending');

    clock.advance(QUORUM_TIMEOUT_MS - 1);
    const stillPending = await recordStandupReport(store, halt.id, 'someone-else', clock.now);
    expect(stillPending.quorum).toBe('pending');

    clock.advance(1);
    const timedOut = await recordStandupReport(store, halt.id, 'someone-else', clock.now);
    expect(timedOut.quorum).toBe('reached');
  });

  test('ticket assignee counts as an affected agent even with no registry record', async () => {
    await store.putTicket(makeTicket('TKT-0001', { assignee: 'eng-9' }));
    const clock = fakeClock(0);
    const halt = await createHalt(
      store,
      { scope: ['TKT-0001'], reason: 'discovery', raised_by: 'architect' },
      clock.now,
    );
    expect(halt.quorum).toBe('pending');
    const after = await recordStandupReport(store, halt.id, 'eng-9', clock.now);
    expect(after.quorum).toBe('reached');
  });
});

describe('quorum survives a daemon restart', () => {
  test('re-opening the store preserves affected/reported and reaches quorum on the last report', async () => {
    await store.putAgent('eng-1', makeAgent({ ticket: 'TKT-0001' }));
    await store.putAgent('eng-2', makeAgent({ ticket: 'TKT-0001' }));
    await store.putTicket(makeTicket('TKT-0001'));

    const clock = fakeClock(0);
    const halt = await createHalt(
      store,
      { scope: ['TKT-0001'], reason: 'discovery', raised_by: 'architect' },
      clock.now,
    );
    expect(halt.quorum).toBe('pending');

    const afterFirst = await recordStandupReport(store, halt.id, 'eng-1', clock.now);
    expect(afterFirst.quorum).toBe('pending');

    // Simulate a daemon restart: a brand new StateStore over the same
    // .agile/ root, no shared process state with the one above.
    const freshStore = StateStore.open(stateRoot);
    const afterSecond = await recordStandupReport(freshStore, halt.id, 'eng-2', clock.now);
    expect(afterSecond.quorum).toBe('reached');

    // The original store handle sees the same durable result too.
    expect(store.getHalt(halt.id).quorum).toBe('reached');
    expect(store.getHalt(halt.id).reported?.sort()).toEqual(['eng-1', 'eng-2']);
  });
});

describe('scoping', () => {
  test('global halt covers every ticket', async () => {
    const clock = fakeClock(0);
    await createHalt(store, { scope: 'global', reason: 'x', raised_by: 'architect' }, clock.now);
    expect(activeHaltsFor(store, 'TKT-0001')).toHaveLength(1);
    expect(activeHaltsFor(store, 'TKT-9999')).toHaveLength(1);
  });

  test('[tickets] scope covers only the listed tickets', async () => {
    const clock = fakeClock(0);
    await createHalt(
      store,
      { scope: ['TKT-0001'], reason: 'x', raised_by: 'architect' },
      clock.now,
    );
    expect(activeHaltsFor(store, 'TKT-0001')).toHaveLength(1);
    expect(activeHaltsFor(store, 'TKT-0002')).toHaveLength(0);
  });
});
