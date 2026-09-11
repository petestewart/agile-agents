import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTicket } from '@agile-agents/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runInit } from '../init';
import { StateStore } from '../store';
import { createArchitectMcpServer } from './verbs';

let repo: string;
let store: StateStore;
let client: Client;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-architect-mcp-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);

  const server = createArchitectMcpServer({ store }, { agent: 'architect' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('createArchitectMcpServer', () => {
  test('lists every architect verb', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'decision_publish',
        'discovery_triage',
        'ticket_create',
        'ticket_point',
        'ticket_refine',
      ].sort(),
    );
  });

  test('ticket_create makes a draft ticket', async () => {
    const result = await client.callTool({
      name: 'ticket_create',
      arguments: { title: 'A new ticket' },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    const ticket = JSON.parse(text);
    expect(ticket.status).toBe('draft');
    expect(ticket.id).toBe('TKT-0001');
  });

  test('QA round 1 fix: ticket_create refuses an unresolved oracle_ref, same as ticket_refine', async () => {
    const result = await client.callTool({
      name: 'ticket_create',
      arguments: { title: 'A new ticket', oracle_refs: ['DEC-9999'] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toMatch(/oracle_refs/);
    // Nothing was written.
    expect(store.listTickets()).toHaveLength(0);
  });

  test('ticket_create accepts a resolvable oracle_ref', async () => {
    await store.putOracleEntry(
      {
        id: 'DEC-0001',
        title: 'x',
        status: 'active',
        supersedes: [],
        depends: [],
        affects: [],
        decided: '2026-09-08',
        by: 'architect',
        rationale: 'x',
      },
      'body',
    );
    const result = await client.callTool({
      name: 'ticket_create',
      arguments: { title: 'A new ticket', oracle_refs: ['DEC-0001'] },
    });
    expect(result.isError).not.toBe(true);
  });

  test('ticket_refine readies a draft with a resolvable oracle ref', async () => {
    await client.callTool({ name: 'ticket_create', arguments: { title: 'A new ticket' } });
    await store.putOracleEntry(
      {
        id: 'DEC-0001',
        title: 'x',
        status: 'active',
        supersedes: [],
        depends: [],
        affects: [],
        decided: '2026-09-08',
        by: 'architect',
        rationale: 'x',
      },
      'body',
    );
    const result = await client.callTool({
      name: 'ticket_refine',
      arguments: {
        id: 'TKT-0001',
        contract: { acceptance: ['it works'] },
        oracle_refs: ['DEC-0001'],
      },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(JSON.parse(text).status).toBe('ready');
  });

  test('ticket_point writes estimate.tier/points/reasoning', async () => {
    await client.callTool({ name: 'ticket_create', arguments: { title: 'A new ticket' } });
    const result = await client.callTool({
      name: 'ticket_point',
      arguments: {
        id: 'TKT-0001',
        answers: {
          points: 3,
          ambiguity: 'contract_specified',
          blastRadius: 'one_module',
          verifiability: 'executable_tests',
          precedent: 'exact_pattern',
        },
      },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.ticket.estimate).toMatchObject({
      points: 3,
      tier: 'trivial',
      reasoning: 'low',
      pointed_by: 'architect',
    });
  });

  test('a non-architect caller is refused', async () => {
    const server = createArchitectMcpServer({ store }, { agent: 'eng-1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const otherClient = new Client({ name: 'test-client-2', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), otherClient.connect(clientTransport)]);
    const result = await otherClient.callTool({ name: 'ticket_create', arguments: { title: 'x' } });
    expect(result.isError).toBe(true);
    await otherClient.close();
  });

  test('discovery_triage raises a halt for a global-scale contradiction', async () => {
    await store.putTicket(
      validateTicket({
        id: 'TKT-0001',
        title: 'reporter',
        status: 'in_progress',
        oracle_refs: ['DEC-0001'],
        contract: {},
        history: [],
      }),
    );
    await store.putTicket(
      validateTicket({
        id: 'TKT-0002',
        title: 'other',
        status: 'in_progress',
        oracle_refs: ['DEC-0001'],
        contract: {},
        history: [],
      }),
    );

    const result = await client.callTool({
      name: 'discovery_triage',
      arguments: {
        reporterTicket: 'TKT-0001',
        discovery: { tier: 'local', affects: ['DEC-0001'], proposed: 'contradiction found' },
      },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.tier).toBe('global');
    expect(parsed.halt.scope).toBe('global');
    expect(store.listHalts()).toHaveLength(1);
  });

  test('discovery_triage tolerates a missing affects list and rejects a malformed discovery with a readable error', async () => {
    // Tenth live run (2026-09-10): the live architect omitted `affects` and
    // the verb crashed with "undefined is not an object (evaluating
    // 'discovery.affects.length')".
    await store.putTicket(
      validateTicket({
        id: 'TKT-0001',
        title: 'reporter',
        status: 'in_progress',
        oracle_refs: ['DEC-0001'],
        contract: {},
        history: [],
      }),
    );
    const ok = await client.callTool({
      name: 'discovery_triage',
      arguments: {
        reporterTicket: 'TKT-0001',
        discovery: { tier: 'scoped', proposed: 'clause 2 is contradictory' },
      },
    });
    expect(ok.isError).not.toBe(true);
    const parsed = JSON.parse(
      (ok.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}',
    );
    expect(parsed.tier).toBe('local');

    const bad = await client.callTool({
      name: 'discovery_triage',
      arguments: { reporterTicket: 'TKT-0001', discovery: { tier: 'huge', proposed: '' } },
    });
    expect(bad.isError).toBe(true);
    const text = (bad.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('discovery_triage: "discovery" must be');
    expect(text).toContain('tier');
  });

  test('decision_publish without a haltId pins the decision to the open architect halt', async () => {
    // Twelfth live run (2026-09-11): the architect published DEC-0001 91 s
    // after raising a global halt, without naming it; the halt had no
    // `resolves_when` and was never released — 60 denials, 0 tickets done.
    for (const [id, assignee] of [
      ['TKT-0001', 'eng-0001'],
      ['TKT-0002', 'eng-0002'],
    ] as const) {
      await store.putTicket(
        validateTicket({
          id,
          title: id,
          status: 'in_progress',
          assignee,
          oracle_refs: ['DEC-0001'],
          contract: {},
          history: [],
        }),
      );
    }
    // A registered agent keeps the global halt's quorum `pending` (nobody
    // has reported), the shape of the live run.
    await store.putAgent('eng-0001', {
      vendor: 'claude',
      model: 'claude-sonnet-4-5',
      last_seen: '2026-09-11T00:00:00Z',
    });
    const triage = await client.callTool({
      name: 'discovery_triage',
      arguments: {
        reporterTicket: 'TKT-0001',
        discovery: {
          tier: 'global',
          affects: ['DEC-0001'],
          proposed: 'clause 2 contradicts clause 1',
        },
      },
    });
    const haltId = JSON.parse(
      (triage.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}',
    ).halt?.id;
    expect(haltId).toBeDefined();
    expect(store.getHalt(haltId).quorum).toBe('pending');

    const result = await client.callTool({
      name: 'decision_publish',
      arguments: {
        entry: {
          id: 'DEC-0007',
          title: 'clause 1 wins',
          status: 'active',
          supersedes: [],
          depends: [],
          affects: [],
          decided: '2026-09-11',
          by: 'architect',
          rationale: 'x',
        },
        body: 'clause 1 wins',
      },
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}',
    );
    expect(parsed.resolves_halts).toEqual([haltId]);
    expect(store.getHalt(haltId).resolves_when).toBe('DEC-0007');
  });

  test('decision_publish with a haltId resolves the halt', async () => {
    await store.putTicket(
      validateTicket({
        id: 'TKT-0001',
        title: 'reporter',
        status: 'in_progress',
        oracle_refs: ['DEC-0001'],
        contract: {},
        history: [],
      }),
    );
    await store.putTicket(
      validateTicket({
        id: 'TKT-0002',
        title: 'other',
        status: 'in_progress',
        oracle_refs: ['DEC-0001'],
        contract: {},
        history: [],
      }),
    );
    const halt = await client.callTool({
      name: 'discovery_triage',
      arguments: {
        reporterTicket: 'TKT-0001',
        discovery: { tier: 'global', affects: ['DEC-0001'], proposed: 'x' },
      },
    });
    const haltId = JSON.parse(
      (halt.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}',
    ).halt?.id;
    expect(haltId).toBeDefined();

    const result = await client.callTool({
      name: 'decision_publish',
      arguments: {
        entry: {
          id: 'DEC-0001',
          title: 'resolves it',
          status: 'active',
          supersedes: [],
          depends: [],
          affects: [],
          decided: '2026-09-08',
          by: 'architect',
          rationale: 'because',
        },
        body: 'the decision body',
        haltId,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(store.listHalts()).toHaveLength(0);
  });
});
