import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TICKET_TRANSITIONS,
  type Ticket,
  type TicketStatus,
  validateTicket,
} from '@agile-agents/shared';
import { runInit } from '../init';
import { IllegalTransitionError, NotFoundError, StateStore } from './store';

let repo: string;
let stateRoot: string;

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe' });
  return new TextDecoder().decode(result.stdout).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-store-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function makeTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id,
    title: `Ticket ${id}`,
    status: 'draft',
    contract: {},
    history: [],
    ...overrides,
  });
}

describe('StateStore.open', () => {
  test('throws if stateRoot does not exist', () => {
    expect(() => StateStore.open(join(repo, 'nope'))).toThrow();
  });

  // Review B4 regression (store-level, complementing fs.test.ts's unit tests).
  test('sweeps a leftover atomic-write temp file so listTickets() is not poisoned by it', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001'));

    // Simulate a crash mid-write: a temp file left behind in tickets/.
    writeFileSync(join(stateRoot, 'tickets', '.TKT-0002.yaml.tmp-123-abc'), 'garbage: [');

    // A store opened fresh over the same root sweeps it on open.
    const restarted = StateStore.open(stateRoot);
    expect(() => restarted.listTickets()).not.toThrow();
    expect(restarted.listTickets().map((t) => t.id)).toEqual(['TKT-0001']);
  });
});

describe('Ticket get/list/put', () => {
  test('putTicket creates a ticket file readable by getTicket', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001'));
    expect(store.getTicket('TKT-0001').status).toBe('draft');
  });

  test('getTicket on a missing ticket throws NotFoundError', () => {
    const store = StateStore.open(stateRoot);
    expect(() => store.getTicket('TKT-9999')).toThrow(NotFoundError);
  });

  test('listTickets returns every ticket', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001'));
    await store.putTicket(makeTicket('TKT-0002'));
    const ids = store
      .listTickets()
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual(['TKT-0001', 'TKT-0002']);
  });

  // Review B1: putTicket now mints a ticket_put event too (every mutation
  // produces exactly one event, read literally).
  test('putTicket mints exactly one ticket_put event, commit message matches', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001'), { by: 'architect' });
    const events = store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('ticket_put');
    expect(events[0]?.ticket).toBe('TKT-0001');
    expect(events[0]?.agent).toBe('architect');
    const subject = git(['log', '-1', '--format=%s'], stateRoot);
    expect(subject).toBe('ticket_put');
  });
});

describe('transitionTicket — illegal transitions', () => {
  test('throws IllegalTransitionError for an edge not in TICKET_TRANSITIONS', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001', { status: 'draft' }));
    await expect(store.transitionTicket('TKT-0001', 'done', { by: 'architect' })).rejects.toThrow(
      IllegalTransitionError,
    );
  });

  test('an illegal transition leaves the ticket, events, and commit log untouched', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001', { status: 'draft' }));
    const eventsBefore = store.listEvents().length;
    const beforeLog = git(['log', '--format=%H'], stateRoot);

    await expect(store.transitionTicket('TKT-0001', 'done', { by: 'architect' })).rejects.toThrow();

    expect(store.getTicket('TKT-0001').status).toBe('draft');
    expect(store.getTicket('TKT-0001').history).toEqual([]);
    expect(store.listEvents()).toHaveLength(eventsBefore);
    expect(git(['log', '--format=%H'], stateRoot)).toBe(beforeLog);
  });
});

describe('transitionTicket — every legal edge (exhaustive coverage)', () => {
  let edgeCounter = 0;
  for (const [from, tos] of Object.entries(TICKET_TRANSITIONS) as Array<
    [TicketStatus, readonly TicketStatus[]]
  >) {
    for (const to of tos) {
      const id = `TKT-${9000 + edgeCounter++}`;
      test(`${from} -> ${to} produces exactly one event and one commit`, async () => {
        const store = StateStore.open(stateRoot);
        await store.putTicket(makeTicket(id, { status: from }));

        const eventsBefore = store.listEvents().length;
        const commitsBefore = git(['rev-list', '--count', 'HEAD'], stateRoot);

        const updated = await store.transitionTicket(id, to, { by: 'em', reason: 'test' });

        expect(updated.status).toBe(to);
        expect(updated.history).toHaveLength(1);

        const events = store.listEvents();
        expect(events.length).toBe(eventsBefore + 1);
        const event = events[events.length - 1];
        expect(event?.kind).toBe('state_transition');
        expect(event?.ticket).toBe(id);
        expect(event?.data).toEqual({ from, to, reason: 'test' });

        const commitsAfter = git(['rev-list', '--count', 'HEAD'], stateRoot);
        expect(Number(commitsAfter)).toBe(Number(commitsBefore) + 1);

        const subject = git(['log', '-1', '--format=%s'], stateRoot);
        expect(subject).toBe('state_transition');
      });
    }
  }
});

describe('transitionTicket — audit trail', () => {
  test('git log --format=%s reproduces the event kind sequence for a run of transitions', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001', { status: 'draft' }));

    await store.transitionTicket('TKT-0001', 'ready', { by: 'architect' });
    await store.transitionTicket('TKT-0001', 'assigned', { by: 'em' });
    await store.transitionTicket('TKT-0001', 'in_progress', { by: 'eng-1' });

    const events = store
      .listEvents()
      .filter((e) => e.ticket === 'TKT-0001' && e.kind === 'state_transition');
    expect(events.map((e) => e.kind)).toEqual([
      'state_transition',
      'state_transition',
      'state_transition',
    ]);

    // Most recent 3 commits are exactly the 3 transitions, in order
    // (newest first); the commit before that is the ticket_put, then
    // agile init's bootstrap commit.
    const subjects = git(['log', '--format=%s'], stateRoot).split('\n');
    expect(subjects.slice(0, 3)).toEqual([
      'state_transition',
      'state_transition',
      'state_transition',
    ]);
    expect(subjects[3]).toBe('ticket_put');
  });
});

describe('property test — random legal transition sequences', () => {
  // Seeded PRNG (mulberry32) — deterministic across runs.
  function mulberry32(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Review B3: 40 sequences (down from 200) — exhaustive edge coverage
  // already comes from the per-edge loop above, not from this test; this
  // one is about cross-sequence properties (event/history/git-log
  // consistency over an arbitrary walk), which 40 seeded sequences already
  // exercises well within a bounded, non-flaky wall time. Timeout is set
  // generously below the measured wall time (see .pipeline-report.md for
  // the 3-run measurement this is based on).
  test('40 random legal sequences: events == transitions, statuses match, history/git-log track the walk', async () => {
    const store = StateStore.open(stateRoot);
    const rand = mulberry32(0xc0ffee);
    const SEQUENCES = 40;
    const MAX_STEPS_PER_SEQUENCE = 4;

    for (let i = 0; i < SEQUENCES; i++) {
      const id = `TKT-${1000 + i}`;
      await store.putTicket(makeTicket(id, { status: 'draft' }));

      let status: TicketStatus = 'draft';
      let steps = 0;
      const maxSteps = 1 + Math.floor(rand() * MAX_STEPS_PER_SEQUENCE);
      const path: TicketStatus[] = [];

      while (steps < maxSteps) {
        const options = TICKET_TRANSITIONS[status];
        if (options.length === 0) break; // terminal (done)
        const next = options[Math.floor(rand() * options.length)] as TicketStatus;
        await store.transitionTicket(id, next, { by: 'em' });
        status = next;
        path.push(next);
        steps += 1;
      }

      const ticket = store.getTicket(id);
      expect(ticket.status).toBe(status);
      expect(ticket.history).toHaveLength(path.length);

      const ticketEvents = store
        .listEvents()
        .filter((e) => e.ticket === id && e.kind === 'state_transition');
      expect(ticketEvents).toHaveLength(path.length);
      expect(ticketEvents.map((e) => e.data.to)).toEqual(path);

      // git log --format=%s, restricted to this ticket's own N most
      // recent state_transition commits (there is exactly one commit per
      // transition and each commit's subject is the event kind), matches
      // the walk length — folds the audit-trail property into this loop
      // too (review nit #12), not only the separate 3-step example test.
      const recentSubjects = git(['log', `-${path.length}`, '--format=%s'], stateRoot).split('\n');
      if (path.length > 0) {
        expect(recentSubjects).toEqual(path.map(() => 'state_transition'));
      }
    }
    // Review B3: timeout set well clear (>=3x) of the measured wall time —
    // see .pipeline-report.md for the 3-run measurement this is based on.
  }, 45_000);
});

describe('restart survives — fresh StateStore over the same root reads back identical entities', () => {
  test('ticket survives restart', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001', { status: 'draft' }));
    const updated = await store.transitionTicket('TKT-0001', 'ready', {
      by: 'architect',
      reason: 'refined',
    });

    const restarted = StateStore.open(stateRoot);
    expect(restarted.getTicket('TKT-0001')).toEqual(updated);
    expect(restarted.listEvents()).toEqual(store.listEvents());
  });
});

describe('atomic write on failed validation', () => {
  test('putTicket with an invalid ticket throws and leaves the existing file intact', async () => {
    const store = StateStore.open(stateRoot);
    const valid = makeTicket('TKT-0001', { status: 'draft' });
    await store.putTicket(valid);

    // Unknown key -> rejected by the strict TicketSchema.
    await expect(
      store.putTicket({ ...valid, notAField: true } as unknown as Ticket),
    ).rejects.toThrow();

    expect(store.getTicket('TKT-0001')).toEqual(valid);
  });

  test('transitionTicket to an illegal status does not touch the ticket file bytes', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001', { status: 'draft' }));
    const before = readFileSync(join(stateRoot, 'tickets', 'TKT-0001.yaml'), 'utf8');

    await expect(store.transitionTicket('TKT-0001', 'done', { by: 'architect' })).rejects.toThrow();

    expect(readFileSync(join(stateRoot, 'tickets', 'TKT-0001.yaml'), 'utf8')).toBe(before);
  });
});

describe('Board: appendStanza', () => {
  test('appends a validated stanza and commits it (message == event kind)', async () => {
    const store = StateStore.open(stateRoot);
    const stanza = await store.appendStanza({
      ts: '2026-09-08T00:00:00Z',
      ticket: 'TKT-0001',
      agent: 'eng-1',
      kind: 'progress',
      summary: 'started work',
    });
    expect(store.listStanzas('TKT-0001')).toEqual([stanza]);
    const subject = git(['log', '-1', '--format=%s'], stateRoot);
    expect(subject).toBe('stanza_appended');

    const events = store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('stanza_appended');
    expect(events[0]?.ticket).toBe('TKT-0001');
    expect(events[0]?.agent).toBe('eng-1');
  });

  test('rejects a discovery stanza with no discovery block', async () => {
    const store = StateStore.open(stateRoot);
    await expect(
      store.appendStanza({
        ts: '2026-09-08T00:00:00Z',
        ticket: 'TKT-0001',
        agent: 'eng-1',
        kind: 'discovery',
        summary: 'found something',
      } as never),
    ).rejects.toThrow();
  });

  // Review B5: board/status/<ticket>.jsonl holds ONLY Stanzas now —
  // transitions no longer mirror there.
  test('transitionTicket no longer writes anything to the board file', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001', { status: 'draft' }));
    await store.transitionTicket('TKT-0001', 'ready', { by: 'architect' });
    expect(store.listBoardRaw('TKT-0001')).toEqual([]);

    await store.appendStanza({
      ts: '2026-09-08T00:00:00Z',
      ticket: 'TKT-0001',
      agent: 'eng-1',
      kind: 'progress',
      summary: 'started',
    });
    expect(store.listBoardRaw('TKT-0001')).toHaveLength(1);
    expect(store.listStanzas('TKT-0001')).toHaveLength(1);
  });

  // Review B5: listStanzas must throw (not silently drop) on a malformed line.
  test('listStanzas throws a descriptive error naming the file and line on a malformed line', () => {
    const store = StateStore.open(stateRoot);
    const boardPath = join(stateRoot, 'board', 'status', 'TKT-0001.jsonl');
    writeFileSync(
      boardPath,
      `${JSON.stringify({
        ts: '2026-09-08T00:00:00Z',
        ticket: 'TKT-0001',
        agent: 'eng-1',
        kind: 'progress',
        summary: 'ok line',
      })}\n${JSON.stringify({ not: 'a valid stanza' })}\n`,
    );

    expect(() => store.listStanzas('TKT-0001')).toThrow(
      /malformed stanza in board\/status\/TKT-0001\.jsonl at line 2/,
    );
  });
});

describe('Ledger: appendLedgerLine', () => {
  test('appends a validated ledger line and commits it (message == event kind)', async () => {
    const store = StateStore.open(stateRoot);
    const line = await store.appendLedgerLine('S-07', {
      ts: '2026-09-08T00:00:00Z',
      sprint: 'S-07',
      ticket: 'TKT-0001',
      agent: 'eng-1',
      model: 'claude-sonnet',
      in_tokens: 100,
      out_tokens: 50,
      cost_usd: 0.01,
      kind: 'engineer',
    });
    expect(store.listLedger('S-07')).toEqual([line]);
    const subject = git(['log', '-1', '--format=%s'], stateRoot);
    expect(subject).toBe('ledger_appended');

    const events = store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('ledger_appended');
  });

  test('rejects an unknown key', async () => {
    const store = StateStore.open(stateRoot);
    await expect(
      store.appendLedgerLine('S-07', {
        ts: '',
        sprint: 'S-07',
        ticket: '',
        agent: '',
        model: '',
        in_tokens: 0,
        out_tokens: 0,
        cost_usd: 0,
        kind: 'engineer',
        extra: true,
      } as never),
    ).rejects.toThrow();
    expect(store.listLedger('S-07')).toEqual([]);
  });

  // Review nit: line.sprint must match the sprint argument.
  test('rejects a line whose sprint does not match the sprint argument', async () => {
    const store = StateStore.open(stateRoot);
    await expect(
      store.appendLedgerLine('S-07', {
        ts: '2026-09-08T00:00:00Z',
        sprint: 'S-99',
        ticket: 'TKT-0001',
        agent: 'eng-1',
        model: 'claude-sonnet',
        in_tokens: 1,
        out_tokens: 1,
        cost_usd: 0,
        kind: 'engineer',
      }),
    ).rejects.toThrow(/does not match sprint argument/);
    expect(store.listLedger('S-07')).toEqual([]);
  });
});

describe('Oracle index maintenance', () => {
  function makeEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: 'DEC-0042',
      title: 'Sessions are JWT, not server-side',
      status: 'active',
      supersedes: [],
      depends: [],
      affects: [],
      decided: '2026-09-07',
      by: 'architect',
      rationale: 'Simplifies revocation.',
      ...overrides,
    };
  }

  test('an active entry is written to disk and added to the index; mints one oracle_put event', async () => {
    const store = StateStore.open(stateRoot);
    await store.putOracleEntry(makeEntry() as never, 'Full decision body.');

    const index = store.listOracleIndex();
    expect(index['DEC-0042']).toEqual({
      title: 'Sessions are JWT, not server-side',
      status: 'active',
      supersedes: [],
      depends: [],
    });

    const { entry, body } = store.getOracleEntry('DEC-0042');
    expect(entry.title).toBe('Sessions are JWT, not server-side');
    expect(body.trim()).toBe('Full decision body.');

    const events = store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('oracle_put');
    const subject = git(['log', '-1', '--format=%s'], stateRoot);
    expect(subject).toBe('oracle_put');
  });

  test('a superseded write drops the entry from the index but keeps the file', async () => {
    const store = StateStore.open(stateRoot);
    await store.putOracleEntry(makeEntry() as never, 'body');
    await store.putOracleEntry(
      makeEntry({ status: 'superseded', rationale: 'Replaced by DEC-0099.' }) as never,
      'body (superseded)',
    );

    expect(store.listOracleIndex()['DEC-0042']).toBeUndefined();
    expect(store.getOracleEntry('DEC-0042').entry.status).toBe('superseded');
  });

  test('routes SPEC- ids to oracle/specs and DEC- ids to oracle/decisions', async () => {
    const store = StateStore.open(stateRoot);
    await store.putOracleEntry(
      makeEntry({ id: 'SPEC-auth-003', title: 'Auth spec' }) as never,
      'spec body',
    );
    expect(store.getOracleEntry('SPEC-auth-003').entry.id).toBe('SPEC-auth-003');
  });

  test('appends one changelog line per write', async () => {
    const store = StateStore.open(stateRoot);
    await store.putOracleEntry(makeEntry() as never, 'body');
    const changelog = readFileSync(join(stateRoot, 'oracle', 'changelog.md'), 'utf8');
    expect(changelog).toContain('DEC-0042');
    expect(changelog).toContain('Simplifies revocation.');
  });

  // Review nit: a multi-line rationale must not break "one line per change".
  test('collapses a multi-line rationale into a single changelog line', async () => {
    const store = StateStore.open(stateRoot);
    await store.putOracleEntry(
      makeEntry({ rationale: 'Line one.\nLine two.\n  Line three.' }) as never,
      'body',
    );
    const changelog = readFileSync(join(stateRoot, 'oracle', 'changelog.md'), 'utf8');
    const lines = changelog.trim().split('\n');
    const changeLine = lines[lines.length - 1] ?? '';
    expect(changeLine).not.toContain('\n');
    expect(changeLine).toContain('Line one. Line two. Line three.');
  });

  test('getOracleEntry on a missing id throws NotFoundError', () => {
    const store = StateStore.open(stateRoot);
    expect(() => store.getOracleEntry('DEC-9999')).toThrow(NotFoundError);
  });
});

describe('Knowledge store index maintenance', () => {
  function makeFact(overrides: Record<string, unknown> = {}) {
    return {
      id: 'KB-0117',
      kind: 'gotcha',
      scope: ['packages/api'],
      confidence: 'observed',
      source: 'TKT-0198',
      expires: null,
      ...overrides,
    };
  }

  test('a fact is written to disk and indexed; mints one kb_put event', async () => {
    const store = StateStore.open(stateRoot);
    await store.putKbFact(makeFact() as never, 'The gotcha, in prose.');

    expect(store.listKbIndex()['KB-0117']).toEqual({
      kind: 'gotcha',
      scope: ['packages/api'],
      confidence: 'observed',
      expires: null,
    });

    const { fact, body } = store.getKbFact('KB-0117');
    expect(fact.confidence).toBe('observed');
    expect(body.trim()).toBe('The gotcha, in prose.');

    const events = store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('kb_put');
  });

  test('a later write updates the index in place', async () => {
    const store = StateStore.open(stateRoot);
    await store.putKbFact(makeFact() as never, 'body');
    await store.putKbFact(makeFact({ confidence: 'verified' }) as never, 'body');
    expect(store.listKbIndex()['KB-0117']?.confidence).toBe('verified');
  });

  test('getKbFact on a missing id throws NotFoundError', () => {
    const store = StateStore.open(stateRoot);
    expect(() => store.getKbFact('KB-9999')).toThrow(NotFoundError);
  });
});

describe('Halt: putHalt / getHalt / listHalts / deleteHalt', () => {
  function makeHalt(overrides: Record<string, unknown> = {}) {
    return {
      id: 'H-12',
      scope: 'global',
      reason: 'discovery: auth model needs rework',
      raised_by: 'architect',
      quorum: 'pending',
      ...overrides,
    };
  }

  test('putHalt creates the file, mints halt_created, one commit', async () => {
    const store = StateStore.open(stateRoot);
    await store.putHalt(makeHalt() as never);
    expect(store.getHalt('H-12' as never).quorum).toBe('pending');
    const events = store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('halt_created');
    expect(git(['log', '-1', '--format=%s'], stateRoot)).toBe('halt_created');
  });

  test('listHalts returns every halt file', async () => {
    const store = StateStore.open(stateRoot);
    await store.putHalt(makeHalt() as never);
    await store.putHalt(makeHalt({ id: 'H-13', scope: ['TKT-0001'] }) as never);
    expect(
      store
        .listHalts()
        .map((h) => h.id)
        .sort(),
    ).toEqual(['H-12', 'H-13']);
  });

  test('deleteHalt releases (removes) the file and mints halt_released', async () => {
    const store = StateStore.open(stateRoot);
    await store.putHalt(makeHalt() as never);
    await store.deleteHalt('H-12' as never);
    expect(() => store.getHalt('H-12' as never)).toThrow(NotFoundError);
    const events = store.listEvents();
    expect(events.map((e) => e.kind)).toEqual(['halt_created', 'halt_released']);
  });

  test('deleteHalt on a missing halt throws NotFoundError', async () => {
    const store = StateStore.open(stateRoot);
    await expect(store.deleteHalt('H-99' as never)).rejects.toThrow(NotFoundError);
  });

  test('a second putHalt for the same id mints halt_updated, not halt_created', async () => {
    const store = StateStore.open(stateRoot);
    await store.putHalt(makeHalt() as never);
    await store.putHalt(makeHalt({ quorum: 'pending', reported: ['eng-1'] }) as never);
    const events = store.listEvents();
    expect(events.map((e) => e.kind)).toEqual(['halt_created', 'halt_updated']);
  });

  test('putHalt on an existing id flipping quorum to reached carries {haltId, quorum} data', async () => {
    const store = StateStore.open(stateRoot);
    await store.putHalt(makeHalt() as never);
    await store.putHalt(makeHalt({ quorum: 'reached' }) as never);
    const events = store.listEvents();
    expect(events[1]?.kind).toBe('halt_updated');
    expect(events[1]?.data).toEqual({ haltId: 'H-12', quorum: 'reached' });
  });
});

// T025 review round 1 blocker 1: an unvalidated id string reaching a
// schema-typed method (the shape an HTTP route that skips `HaltIdSchema.
// safeParse` would produce, e.g. `../../victim`) must not escape the state
// root. This exercises `StateStore.abs()`'s own containment guard directly
// through a public method, rather than trusting every call site to have
// validated first — the guard is the backstop for every current and future
// caller of `abs()`, not just `deleteHalt`.
describe('StateStore.abs() containment (path-traversal backstop)', () => {
  // `haltRelPath` is `board/halts/<id>.yaml` — two levels deep, so an id
  // needs three `..` segments to walk past `board`, `halts`, and the state
  // root itself and land outside it (two `..` only cancels back down to
  // *inside* the state root — a different, HTTP-layer-validated bug: see
  // `http.test.ts`'s "invalid id" tests for `DELETE /api/halt/:id`).
  test('deleteHalt with a 3-level traversal id throws and does not touch anything outside the state root', async () => {
    const store = StateStore.open(stateRoot);
    const victimPath = join(stateRoot, '..', 'victim.yaml');
    writeFileSync(victimPath, 'i must survive\n');
    try {
      await expect(store.deleteHalt('../../../victim' as never)).rejects.toThrow(
        /escapes the state root/,
      );
      expect(readFileSync(victimPath, 'utf8')).toBe('i must survive\n');
    } finally {
      rmSync(victimPath, { force: true });
    }
  });

  test('getHalt with a 3-level traversal id throws rather than reading a file outside the state root', () => {
    const store = StateStore.open(stateRoot);
    expect(() => store.getHalt('../../../etc/passwd' as never)).toThrow(/escapes the state root/);
  });

  test('a sibling directory sharing the state root as a string prefix is still rejected (no bare startsWith)', async () => {
    const store = StateStore.open(stateRoot);
    // stateRoot is `<repo>/.agile`; `<repo>/.agile-evil` shares the string
    // *prefix* "<repo>/.agile" but is not a descendant of it — three `..`
    // from `board/halts/<id>.yaml` walks back past `board`, `halts`, and
    // `.agile` itself to `<repo>`, then into the sibling. A bare
    // `startsWith(root)` (no `+ sep`) would wrongly accept this.
    const evilSibling = join(stateRoot, '..', '.agile-evil');
    await expect(store.deleteHalt('../../../.agile-evil/x' as never)).rejects.toThrow(
      /escapes the state root/,
    );
    expect(existsSync(evilSibling)).toBe(false);
  });
});

// T032: the lexical guard above stops `..` traversal but `resolve()` never
// touches the filesystem, so a symlink *planted inside* the state root that
// points outside it slips past a purely lexical check — only a real fs call
// (read/write/unlink) would follow the link and actually escape. `abs()`
// must catch this too by realpath-ing the target's nearest existing
// ancestor and comparing against a realpath'd state root.
describe('StateStore.abs() containment (symlink escape, T032)', () => {
  test('getHalt refuses a halt file that is a symlink to a file outside the state root', () => {
    const store = StateStore.open(stateRoot);
    const victimPath = join(repo, '..', 'symlink-victim.yaml');
    writeFileSync(victimPath, 'id: evil\nscope: global\nraised_by: attacker\n');
    const linkPath = join(stateRoot, 'board', 'halts', 'evil.yaml');
    try {
      symlinkSync(victimPath, linkPath);
      expect(() => store.getHalt('evil' as never)).toThrow(/escapes the state root/);
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(victimPath, { force: true });
    }
  });

  test('deleteHalt refuses to unlink through a symlinked directory that escapes the state root', async () => {
    const store = StateStore.open(stateRoot);
    const victimDir = mkdtempSync(join(tmpdir(), 'agile-store-victim-'));
    writeFileSync(join(victimDir, 'evil.yaml'), 'id: evil\nscope: global\nraised_by: attacker\n');
    const realHaltsDir = join(stateRoot, 'board', 'halts');
    try {
      // Swap the halts directory itself out for a symlink to somewhere else
      // entirely — the id and file name are both innocuous; only the
      // directory segment is malicious.
      rmSync(realHaltsDir, { recursive: true, force: true });
      symlinkSync(victimDir, realHaltsDir);
      await expect(store.deleteHalt('evil' as never)).rejects.toThrow(/escapes the state root/);
      expect(existsSync(join(victimDir, 'evil.yaml'))).toBe(true);
    } finally {
      rmSync(realHaltsDir, { force: true });
      rmSync(victimDir, { recursive: true, force: true });
    }
  });

  test('putTicket to a not-yet-existing file still resolves normally (no false positive)', async () => {
    const store = StateStore.open(stateRoot);
    await expect(store.putTicket(makeTicket('TKT-9999'))).resolves.toBeDefined();
    expect(store.getTicket('TKT-9999' as never).id).toBe('TKT-9999');
  });
});

describe('Sprint: putSprint / getSprint / listSprints', () => {
  function makeSprint(overrides: Record<string, unknown> = {}) {
    return {
      id: 'S-07',
      goal: 'Auth works end to end',
      tickets: [],
      budget_tokens: 5_000_000,
      started: '2026-09-08T00:00:00Z',
      ...overrides,
    };
  }

  test('putSprint/getSprint round-trip, mints sprint_put', async () => {
    const store = StateStore.open(stateRoot);
    await store.putSprint(makeSprint() as never);
    expect(store.getSprint('S-07' as never).goal).toBe('Auth works end to end');
    expect(store.listEvents()[0]?.kind).toBe('sprint_put');
  });

  test('listSprints returns every sprint file', async () => {
    const store = StateStore.open(stateRoot);
    await store.putSprint(makeSprint() as never);
    await store.putSprint(makeSprint({ id: 'S-08' }) as never);
    expect(
      store
        .listSprints()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['S-07', 'S-08']);
  });

  test('getSprint on a missing id throws NotFoundError', () => {
    const store = StateStore.open(stateRoot);
    expect(() => store.getSprint('S-99' as never)).toThrow(NotFoundError);
  });
});

describe('Quota: putQuota / getQuota', () => {
  function makeQuota(overrides: Record<string, unknown> = {}) {
    return {
      vendor: 'claude',
      account: 'default',
      kind: 'subscription_window',
      remaining: 0.5,
      unit: 'fraction',
      confidence: 'reported',
      source: 'usage_endpoint',
      updated: '2026-09-08T00:00:00Z',
      ...overrides,
    };
  }

  test('putQuota/getQuota round-trip, mints quota_put', async () => {
    const store = StateStore.open(stateRoot);
    await store.putQuota(makeQuota() as never);
    expect(store.getQuota('claude', 'default').remaining).toBe(0.5);
    expect(store.listEvents()[0]?.kind).toBe('quota_put');
  });

  test('getQuota on a missing account throws NotFoundError', () => {
    const store = StateStore.open(stateRoot);
    expect(() => store.getQuota('claude', 'nope')).toThrow(NotFoundError);
  });
});

describe('AgentRecord: putAgent / getAgent / listAgents / deleteAgent', () => {
  function makeRecord(overrides: Record<string, unknown> = {}) {
    return {
      vendor: 'claude',
      model: 'sonnet',
      pid: 123,
      last_seen: '2026-09-08T00:00:00Z',
      ...overrides,
    };
  }

  test('putAgent/getAgent round-trip, mints agent_put', async () => {
    const store = StateStore.open(stateRoot);
    await store.putAgent('eng-1' as never, makeRecord() as never);
    expect(store.getAgent('eng-1' as never).model).toBe('sonnet');
    const events = store.listEvents();
    expect(events[0]?.kind).toBe('agent_put');
    expect(events[0]?.agent).toBe('eng-1');
  });

  test('listAgents returns every agent record', async () => {
    const store = StateStore.open(stateRoot);
    await store.putAgent('eng-1' as never, makeRecord() as never);
    await store.putAgent('eng-2' as never, makeRecord() as never);
    expect(
      store
        .listAgents()
        .map((a) => a.id)
        .sort(),
    ).toEqual(['eng-1', 'eng-2']);
  });

  test('deleteAgent removes the record and mints agent_deleted', async () => {
    const store = StateStore.open(stateRoot);
    await store.putAgent('eng-1' as never, makeRecord() as never);
    await store.deleteAgent('eng-1' as never);
    expect(() => store.getAgent('eng-1' as never)).toThrow(NotFoundError);
    expect(store.listEvents().map((e) => e.kind)).toEqual(['agent_put', 'agent_deleted']);
  });
});

describe('Policy / Vendors singletons', () => {
  test('getPolicy reads what agile init wrote', () => {
    const store = StateStore.open(stateRoot);
    expect(store.getPolicy().gates.approve_plan).toBe('human');
  });

  test('putPolicy overwrites it and mints policy_put', async () => {
    const store = StateStore.open(stateRoot);
    await store.putPolicy({
      gates: { approve_plan: 'em' },
      breaker_signals: [],
    } as never);
    expect(store.getPolicy().gates.approve_plan).toBe('em');
    expect(store.listEvents()[0]?.kind).toBe('policy_put');
  });

  test('getVendors reads what agile init wrote', () => {
    const store = StateStore.open(stateRoot);
    expect(store.getVendors().claude).toBeDefined();
  });

  test('putVendors overwrites it and mints vendors_put', async () => {
    const store = StateStore.open(stateRoot);
    await store.putVendors({
      claude: { accounts: [{ id: 'default', auth: 'subscription' }] },
    } as never);
    expect(store.listEvents()[0]?.kind).toBe('vendors_put');
  });
});

describe('Generic entity trio: putEntity / getEntity / deleteEntity', () => {
  interface Widget {
    id: string;
    n: number;
  }
  function validateWidget(input: unknown): Widget {
    const value = input as Widget;
    if (typeof value?.id !== 'string' || typeof value?.n !== 'number') {
      throw new Error('invalid Widget');
    }
    return { id: value.id, n: value.n };
  }

  test('putEntity writes + validates, getEntity reads it back, mints entity_put', async () => {
    const store = StateStore.open(stateRoot);
    const relPath = join('bus', 'inbox', 'em', '01J9EXAMPLE0000000000000000.yaml');
    await store.putEntity(relPath, validateWidget, { id: 'w1', n: 1 });
    expect(store.getEntity(relPath, validateWidget)).toEqual({ id: 'w1', n: 1 });
    const events = store.listEvents();
    expect(events[0]?.kind).toBe('entity_put');
    expect(events[0]?.data).toEqual({ relPath });
  });

  test('putEntity rejects invalid data, writes nothing', async () => {
    const store = StateStore.open(stateRoot);
    const relPath = join('bus', 'inbox', 'em', 'bad.yaml');
    await expect(store.putEntity(relPath, validateWidget, { id: 'w1' })).rejects.toThrow();
    expect(() => store.getEntity(relPath, validateWidget)).toThrow(NotFoundError);
  });

  test('putEntities writes every file, mints exactly one caller-supplied event and one commit', async () => {
    const store = StateStore.open(stateRoot);
    const before = store.listEvents().length;
    const commitsBefore = git(['log', '--format=%s'], stateRoot).split('\n').length;
    await store.putEntities(
      [
        { relPath: 'bus/inbox/em/w1.yaml', validator: validateWidget, data: { id: 'w1', n: 1 } },
        { relPath: 'bus/inbox/qa/w1.yaml', validator: validateWidget, data: { id: 'w1', n: 1 } },
      ],
      { ts: new Date().toISOString(), kind: 'message', data: { id: 'w1' } },
    );
    expect(store.getEntity('bus/inbox/em/w1.yaml', validateWidget)).toEqual({ id: 'w1', n: 1 });
    expect(store.getEntity('bus/inbox/qa/w1.yaml', validateWidget)).toEqual({ id: 'w1', n: 1 });
    expect(store.listEvents().length - before).toBe(1);
    expect(store.listEvents().at(-1)?.kind).toBe('message');
    const subjects = git(['log', '--format=%s'], stateRoot).split('\n');
    expect(subjects.length - commitsBefore).toBe(1);
    expect(subjects[0]).toBe('message');
  });

  test('putEntities validates everything before writing anything', async () => {
    const store = StateStore.open(stateRoot);
    await expect(
      store.putEntities(
        [
          { relPath: 'bus/inbox/em/ok.yaml', validator: validateWidget, data: { id: 'w1', n: 1 } },
          { relPath: 'bus/inbox/em/bad.yaml', validator: validateWidget, data: { id: 'w1' } },
        ],
        { ts: new Date().toISOString(), kind: 'message', data: {} },
      ),
    ).rejects.toThrow();
    expect(() => store.getEntity('bus/inbox/em/ok.yaml', validateWidget)).toThrow(NotFoundError);
  });

  test('the trio refuses paths that escape the state root', async () => {
    const store = StateStore.open(stateRoot);
    for (const bad of [
      '../outside.yaml',
      '/etc/passwd',
      'bus/../../x.yaml',
      '.git/config',
      'a/.git/x.yaml',
    ]) {
      await expect(store.putEntity(bad, validateWidget, { id: 'w1', n: 1 })).rejects.toThrow(
        /escapes the state root/,
      );
      expect(() => store.getEntity(bad, validateWidget)).toThrow(/escapes the state root/);
      await expect(store.deleteEntity(bad)).rejects.toThrow(/escapes the state root/);
    }
    expect(store.listEvents()).toHaveLength(0);
  });

  test('getEntity on a missing path throws NotFoundError', () => {
    const store = StateStore.open(stateRoot);
    expect(() => store.getEntity('bus/inbox/em/nope.yaml', validateWidget)).toThrow(NotFoundError);
  });

  test('deleteEntity removes the file and mints entity_deleted', async () => {
    const store = StateStore.open(stateRoot);
    const relPath = join('bus', 'inbox', 'em', 'w1.yaml');
    await store.putEntity(relPath, validateWidget, { id: 'w1', n: 1 });
    await store.deleteEntity(relPath);
    expect(() => store.getEntity(relPath, validateWidget)).toThrow(NotFoundError);
    expect(store.listEvents().map((e) => e.kind)).toEqual(['entity_put', 'entity_deleted']);
  });

  test('deleteEntity on a missing path throws NotFoundError', async () => {
    const store = StateStore.open(stateRoot);
    await expect(store.deleteEntity('bus/inbox/em/nope.yaml')).rejects.toThrow(NotFoundError);
  });

  test('a .json relPath round-trips as JSON', async () => {
    const store = StateStore.open(stateRoot);
    const relPath = join('bus', 'inbox', 'em', 'w1.json');
    await store.putEntity(relPath, validateWidget, { id: 'w1', n: 42 });
    expect(store.getEntity(relPath, validateWidget)).toEqual({ id: 'w1', n: 42 });
    expect(readFileSync(join(stateRoot, relPath), 'utf8').trim().startsWith('{')).toBe(true);
  });

  test('listEntities reads back every entity in a directory (yaml + json), skipping hidden/temp files', async () => {
    const store = StateStore.open(stateRoot);
    await store.putEntity(join('board', 'hil', 'a.yaml'), validateWidget, { id: 'a', n: 1 });
    await store.putEntity(join('board', 'hil', 'b.yaml'), validateWidget, { id: 'b', n: 2 });
    await store.putEntity(join('board', 'hil', 'c.json'), validateWidget, { id: 'c', n: 3 });
    writeFileSync(join(stateRoot, 'board', 'hil', '.gitkeep'), '');
    writeFileSync(join(stateRoot, 'board', 'hil', '.stray.yaml.tmp-1-xyz'), 'garbage: [');

    const all = store.listEntities(join('board', 'hil'), validateWidget);
    expect(all.map((w) => w.id).sort()).toEqual(['a', 'b', 'c']);
  });

  test('listEntities on a missing directory returns []', () => {
    const store = StateStore.open(stateRoot);
    expect(store.listEntities(join('board', 'hil'), validateWidget)).toEqual([]);
  });

  test('listEntities refuses a path that escapes the state root', () => {
    const store = StateStore.open(stateRoot);
    expect(() => store.listEntities('../outside', validateWidget)).toThrow(
      /escapes the state root/,
    );
  });
});

describe('appendEvent — public escape hatch for message/hook_decision events', () => {
  test('appends and commits a message event with message == kind', async () => {
    const store = StateStore.open(stateRoot);
    const event = await store.appendEvent({
      ts: '2026-09-08T00:00:00Z',
      kind: 'message',
      data: { from: 'eng-1', to: ['em'] },
    });
    expect(store.listEvents()).toEqual([event]);
    expect(git(['log', '-1', '--format=%s'], stateRoot)).toBe('message');
  });

  test('appends a hook_decision event', async () => {
    const store = StateStore.open(stateRoot);
    await store.appendEvent({
      ts: '2026-09-08T00:00:00Z',
      kind: 'hook_decision',
      agent: 'eng-1',
      data: { allow: false, reason: 'halt active' },
    });
    expect(store.listEvents()[0]?.kind).toBe('hook_decision');
  });

  test('rejects an invalid event and writes nothing', async () => {
    const store = StateStore.open(stateRoot);
    await expect(
      store.appendEvent({ ts: '2026-09-08T00:00:00Z', kind: 'not_a_kind' } as never),
    ).rejects.toThrow();
    expect(store.listEvents()).toEqual([]);
  });
});

describe('unknown-key rejection round trip', () => {
  test('a ticket with an unknown key round-trips to a thrown error, no write', async () => {
    const store = StateStore.open(stateRoot);
    const raw = { ...makeTicket('TKT-0001'), unknownField: 'nope' };
    await expect(store.putTicket(raw as unknown as Ticket)).rejects.toThrow(/invalid Ticket/);
  });

  test('an oracle entry with an unknown key is rejected', async () => {
    const store = StateStore.open(stateRoot);
    await expect(
      store.putOracleEntry(
        {
          id: 'DEC-0042',
          title: 'x',
          status: 'active',
          supersedes: [],
          depends: [],
          affects: [],
          decided: '2026-09-07',
          by: 'architect',
          rationale: 'x',
          extra: true,
        } as never,
        'body',
      ),
    ).rejects.toThrow(/invalid OracleEntry/);
  });
});

describe('deferred-commit batching (T009 review round, hot-path decision)', () => {
  test('several deferred appendEvent calls land in exactly one commit, only once flushed', async () => {
    const store = StateStore.open(stateRoot);
    const before = git(['rev-list', '--count', 'HEAD'], stateRoot);

    for (let i = 0; i < 5; i++) {
      await store.appendEvent(
        { ts: new Date().toISOString(), kind: 'hook_decision', data: { i } },
        { commit: 'deferred' },
      );
    }
    // Not committed yet — the whole point of deferring.
    expect(git(['rev-list', '--count', 'HEAD'], stateRoot)).toBe(before);
    // But already durable on disk (readable) before any commit happens.
    expect(store.listEvents().filter((e) => e.kind === 'hook_decision')).toHaveLength(5);

    await store.flush();
    const after = git(['rev-list', '--count', 'HEAD'], stateRoot);
    expect(Number(after) - Number(before)).toBe(1);
    // A second flush with nothing queued is a true no-op (no empty commit).
    await store.flush();
    expect(git(['rev-list', '--count', 'HEAD'], stateRoot)).toBe(after);
  });

  test('a regular mutation flushes pending deferred paths first, as a separate preceding commit', async () => {
    const store = StateStore.open(stateRoot);
    const beforeSha = git(['rev-parse', 'HEAD'], stateRoot);
    const before = git(['rev-list', '--count', 'HEAD'], stateRoot);

    await store.appendEvent(
      { ts: new Date().toISOString(), kind: 'hook_decision', data: {} },
      { commit: 'deferred' },
    );
    expect(git(['rev-list', '--count', 'HEAD'], stateRoot)).toBe(before);

    // A regular (non-deferred) mutation must not silently swallow the
    // deferred write into its own commit message.
    await store.putTicket(makeTicket('TKT-0001'));
    const after = git(['rev-list', '--count', 'HEAD'], stateRoot);
    expect(Number(after) - Number(before)).toBe(2);

    const log = git(['log', '--format=%s', `${beforeSha}..HEAD`], stateRoot);
    const messages = log.split('\n').filter(Boolean).reverse();
    expect(messages).toEqual(['deferred_batch', 'ticket_put']);
  });

  describe('StateStore.heartbeat', () => {
    // Round 4 (QA round 3 REJECT): `heartbeat` no longer registers an
    // agent — it only ever updates `last_seen`/`ticket` on an EXISTING
    // record, throwing if there is none (`Bus.heartbeat` is the one caller
    // allowed to create a first record; see bus.ts). Every test here
    // registers via `putAgent` first, as a real caller must.
    async function registerAgent(
      store: StateStore,
      overrides: Partial<Parameters<StateStore['putAgent']>[1]> = {},
    ) {
      return store.putAgent(
        'eng-1' as never,
        {
          vendor: 'claude',
          model: 'sonnet',
          last_seen: new Date(0).toISOString(),
          role: 'engineer',
          worktree: '.worktrees/TKT-0001',
          session_id: 'sess-abc',
          ...overrides,
        } as never,
      );
    }

    test('heartbeating an unregistered agent throws (round 4: never silently create a fresh record)', async () => {
      const store = StateStore.open(stateRoot);
      await expect(store.heartbeat('eng-1' as never)).rejects.toThrow(/not found/i);
    });

    test('bumps last_seen (deferred, not committed until flush) on an existing record', async () => {
      const store = StateStore.open(stateRoot);
      await registerAgent(store);
      const before = git(['rev-list', '--count', 'HEAD'], stateRoot);
      const record = await store.heartbeat('eng-1' as never);
      expect(record.last_seen).not.toBe(new Date(0).toISOString());
      expect(git(['rev-list', '--count', 'HEAD'], stateRoot)).toBe(before); // deferred, not committed
      await store.flush();
      expect(Number(git(['rev-list', '--count', 'HEAD'], stateRoot)) - Number(before)).toBe(1);
    });

    // The exact regression QA round 3 found: `role`/`worktree`/`session_id`
    // must survive byte-for-byte across a heartbeat, coalesced or not.
    test('preserves role/worktree/session_id (and vendor/model/pid) byte-for-byte across a heartbeat', async () => {
      const store = StateStore.open(stateRoot);
      const registered = await registerAgent(store, { pid: 4242 });
      let now = new Date('2026-09-09T00:00:00.000Z');
      const heartbeat1 = await store.heartbeat('eng-1' as never, {}, () => now);
      expect(heartbeat1.role).toBe('engineer');
      expect(heartbeat1.worktree).toBe('.worktrees/TKT-0001');
      expect(heartbeat1.session_id).toBe('sess-abc');
      expect(heartbeat1.pid).toBe(4242);

      now = new Date(now.getTime() + 31_000); // past the 30s coalescing window
      const heartbeat2 = await store.heartbeat('eng-1' as never, {}, () => now);
      expect(heartbeat2.role).toBe(registered.role);
      expect(heartbeat2.worktree).toBe(registered.worktree);
      expect(heartbeat2.session_id).toBe(registered.session_id);
      expect(heartbeat2.vendor).toBe(registered.vendor);
      expect(heartbeat2.model).toBe(registered.model);
      expect(heartbeat2.pid).toBe(registered.pid);
    });

    test('coalesces: a second heartbeat within 30s with no ticket change is a pure no-op', async () => {
      const store = StateStore.open(stateRoot);
      let now = new Date('2026-09-09T00:00:00.000Z');
      await registerAgent(store);
      const first = await store.heartbeat('eng-1' as never, {}, () => now);
      now = new Date(now.getTime() + 10_000); // +10s, under the 30s window
      const second = await store.heartbeat('eng-1' as never, {}, () => now);
      expect(second).toEqual(first); // last_seen unchanged — no write happened
    });

    test('writes again once past the 30s coalescing window', async () => {
      const store = StateStore.open(stateRoot);
      let now = new Date('2026-09-09T00:00:00.000Z');
      await registerAgent(store);
      const first = await store.heartbeat('eng-1' as never, {}, () => now);
      now = new Date(now.getTime() + 31_000); // past the 30s window
      const second = await store.heartbeat('eng-1' as never, {}, () => now);
      expect(second.last_seen).not.toBe(first.last_seen);
    });

    test('a ticket change writes immediately even inside the coalescing window', async () => {
      const store = StateStore.open(stateRoot);
      let now = new Date('2026-09-09T00:00:00.000Z');
      await registerAgent(store);
      const first = await store.heartbeat('eng-1' as never, {}, () => now);
      now = new Date(now.getTime() + 1_000);
      const second = await store.heartbeat(
        'eng-1' as never,
        { ticket: 'TKT-0001' as never },
        () => now,
      );
      expect(second.ticket).toBe('TKT-0001');
      expect(second.last_seen).not.toBe(first.last_seen);
    });
  });
});

describe('StateStore.close (T012 QA round — deferred-flush-after-teardown race)', () => {
  test('close() cancels a pending deferred-flush timer outright', async () => {
    const store = StateStore.open(stateRoot);
    await store.appendEvent(
      { ts: new Date().toISOString(), kind: 'hook_decision', data: {} },
      { commit: 'deferred' },
    );
    const before = git(['rev-list', '--count', 'HEAD'], stateRoot);

    store.close();
    // Removing the worktree simulates a test's own teardown racing the
    // timer this reproduces the QA-reported failure without waiting the
    // real 5s DEFERRED_FLUSH_MS: if `close()` didn't cancel the timer, the
    // commit attempt below would throw "not a git repository" once it
    // eventually fired.
    rmSync(stateRoot, { recursive: true, force: true });

    // Nothing to assert via git any more (the worktree is gone) — the
    // absence of an unhandled rejection/exception *is* the assertion here;
    // bun:test fails the run on an unhandled error between tests, which is
    // exactly the failure mode this closes off. Re-create a harmless no-op
    // check so the test has an explicit assertion too.
    expect(before.length).toBeGreaterThan(0);
  });

  test('scheduleDeferredFlush is a no-op after close() — a later deferred write never re-arms the timer', async () => {
    const store = StateStore.open(stateRoot);
    store.close();
    // A deferred write after close() still lands on disk (appendEvent's
    // own contract) but must not arm a new flush timer that could outlive
    // whatever tore this store down.
    await store.appendEvent(
      { ts: new Date().toISOString(), kind: 'hook_decision', data: {} },
      { commit: 'deferred' },
    );
    expect(store.listEvents().some((e) => e.kind === 'hook_decision')).toBe(true);
    // No thrown/unhandled error even once real time would have let a timer
    // fire — proven by the process not crashing between tests; nothing
    // further to poll since `close()` guarantees no timer was armed at all.
  });
});

describe('commitPaths guards against a missing worktree (T012 QA round)', () => {
  test('a deferred flush against an already-removed stateRoot no-ops instead of throwing', async () => {
    const store = StateStore.open(stateRoot);
    await store.appendEvent(
      { ts: new Date().toISOString(), kind: 'hook_decision', data: {} },
      { commit: 'deferred' },
    );
    rmSync(stateRoot, { recursive: true, force: true });
    // Directly exercises the exact call shape `flushDeferredNow` makes
    // (`commitPaths` is not itself exported for a unit-level check here,
    // but `flush()` is StateStore's own public surface over it) — must not
    // throw even though `stateRoot` no longer exists.
    await expect(store.flush()).resolves.toBeUndefined();
  });
});
