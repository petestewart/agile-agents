import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('putTicket commits, with no event emitted (creation is not a transition)', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001'));
    expect(store.listEvents()).toEqual([]);
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

  test('an illegal transition leaves the ticket, board, events, and commit log untouched', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001', { status: 'draft' }));
    const beforeLog = git(['log', '--format=%H'], stateRoot);

    await expect(store.transitionTicket('TKT-0001', 'done', { by: 'architect' })).rejects.toThrow();

    expect(store.getTicket('TKT-0001').status).toBe('draft');
    expect(store.getTicket('TKT-0001').history).toEqual([]);
    expect(store.listEvents()).toEqual([]);
    expect(store.listBoardRaw('TKT-0001')).toEqual([]);
    expect(git(['log', '--format=%H'], stateRoot)).toBe(beforeLog);
  });
});

describe('transitionTicket — every legal edge', () => {
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

    const events = store.listEvents();
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

  test('200 random legal sequences: events == transitions, statuses match, history grows by one per step', async () => {
    const store = StateStore.open(stateRoot);
    const rand = mulberry32(0xc0ffee);
    const SEQUENCES = 200;
    const MAX_STEPS_PER_SEQUENCE = 4; // keep git-spawn count bounded for test runtime

    for (let i = 0; i < SEQUENCES; i++) {
      const id = `TKT-${1000 + i}`;
      await store.putTicket(makeTicket(id, { status: 'draft' }));

      let status: TicketStatus = 'draft';
      let steps = 0;
      const maxSteps = 1 + Math.floor(rand() * MAX_STEPS_PER_SEQUENCE); // 1..MAX_STEPS_PER_SEQUENCE transitions per sequence
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

      const boardEvents = store
        .listBoardRaw(id)
        .filter(
          (line): line is { kind: string } =>
            typeof line === 'object' && line !== null && 'kind' in line,
        )
        .filter((line) => line.kind === 'state_transition');
      expect(boardEvents).toHaveLength(path.length);

      const ticketEvents = store.listEvents().filter((e) => e.ticket === id);
      expect(ticketEvents).toHaveLength(path.length);
      expect(ticketEvents.map((e) => e.data.to)).toEqual(path);
    }
  }, 60_000);
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
  test('appends a validated stanza and commits it', async () => {
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
    expect(subject).toBe('stanza:progress');
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

  test('listStanzas filters out state_transition board lines', async () => {
    const store = StateStore.open(stateRoot);
    await store.putTicket(makeTicket('TKT-0001', { status: 'draft' }));
    await store.transitionTicket('TKT-0001', 'ready', { by: 'architect' });
    await store.appendStanza({
      ts: '2026-09-08T00:00:00Z',
      ticket: 'TKT-0001',
      agent: 'eng-1',
      kind: 'progress',
      summary: 'started',
    });

    expect(store.listBoardRaw('TKT-0001')).toHaveLength(2);
    expect(store.listStanzas('TKT-0001')).toHaveLength(1);
  });
});

describe('Ledger: appendLedgerLine', () => {
  test('appends a validated ledger line and commits it', async () => {
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
    expect(subject).toBe('ledger_append');
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

  test('an active entry is written to disk and added to the index', async () => {
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

  test('a fact is written to disk and indexed', async () => {
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
