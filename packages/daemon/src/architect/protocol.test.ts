import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTicket } from '@agile-agents/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runInit } from '../init';
import { StateStore } from '../store';
import { runDiscoveryProtocol } from './protocol';
import { reRefineStale } from './refine';
import { createArchitectMcpServer } from './verbs';

let repo: string;
let store: StateStore;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-architect-protocol-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);

  await store.putOracleEntry(
    {
      id: 'DEC-0001',
      title: 'Sessions are cookie-based',
      status: 'active',
      supersedes: [],
      depends: [],
      affects: [],
      decided: '2026-09-01',
      by: 'architect',
      rationale: 'original call',
    },
    'Original decision body.',
  );

  // Three live tickets, all built on the contradicted decision (T014
  // acceptance: "a seeded contradiction in a ticket's contract").
  await store.putTicket(
    validateTicket({
      id: 'TKT-0001',
      title: 'Reporter: login endpoint',
      status: 'in_progress',
      oracle_refs: ['DEC-0001'],
      contract: { acceptance: ['logs in'] },
      history: [],
    }),
  );
  await store.putTicket(
    validateTicket({
      id: 'TKT-0002',
      title: 'Session refresh',
      status: 'in_progress',
      oracle_refs: ['DEC-0001'],
      contract: { acceptance: ['refreshes'] },
      history: [],
    }),
  );
  await store.putTicket(
    validateTicket({
      id: 'TKT-0003',
      title: 'Logout endpoint',
      status: 'ready',
      oracle_refs: ['DEC-0001'],
      contract: { acceptance: ['logs out'] },
      history: [],
    }),
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('discovery -> standup -> resume, driven by a fake architect over the in-process MCP server', () => {
  test('every state/event in the T014 acceptance scenario: discovery -> global halt -> new DEC -> stale -> re-refined ready', async () => {
    const server = createArchitectMcpServer({ store }, { agent: 'architect' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fake-architect', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Step 1 (§5): engineer's discovery reaches the architect; architect
    // confirms/changes tier via discovery_triage.
    const triageResult = await client.callTool({
      name: 'discovery_triage',
      arguments: {
        reporterTicket: 'TKT-0001',
        discovery: {
          tier: 'local',
          affects: ['DEC-0001'],
          proposed: 'DEC-0001 contradicts the new SSO requirement — sessions must be JWT',
        },
      },
    });
    expect(triageResult.isError).not.toBe(true);
    const triage = JSON.parse((triageResult.content as Array<{ text: string }>)[0]?.text ?? '{}');
    expect(triage.tier).toBe('global');
    expect(new Set(triage.affected)).toEqual(new Set(['TKT-0002', 'TKT-0003']));
    expect(triage.halt.scope).toBe('global');
    const haltId = triage.halt.id;

    // Step 3 (§5): halt is live, nothing staled yet.
    expect(store.listHalts().map((h) => h.id)).toEqual([haltId]);
    expect(store.getTicket('TKT-0002').status).toBe('in_progress');

    // Step 6 (§5): architect publishes the resolving decision through
    // decision_publish, naming the halt it resolves.
    const publishResult = await client.callTool({
      name: 'decision_publish',
      arguments: {
        entry: {
          id: 'DEC-0002',
          title: 'Sessions are JWT, not cookie-based',
          status: 'active',
          supersedes: ['DEC-0001'],
          depends: [],
          affects: ['DEC-0001'],
          decided: '2026-09-09',
          by: 'architect',
          rationale: 'SSO requires a bearer token, not a cookie session',
        },
        body: 'Sessions switch to JWT.',
        haltId,
      },
    });
    expect(publishResult.isError).not.toBe(true);
    const published = JSON.parse(
      (publishResult.content as Array<{ text: string }>)[0]?.text ?? '{}',
    );
    expect(published.released).toBe(true);

    // Step 7 (§5): halt released; ripple staled every live ticket citing DEC-0001.
    expect(store.listHalts()).toHaveLength(0);
    expect(new Set(published.oracle.stale)).toEqual(new Set(['TKT-0001', 'TKT-0002', 'TKT-0003']));
    for (const id of published.oracle.stale) {
      expect(store.getTicket(id).status).toBe('stale');
    }
    expect(store.getOracleEntry('DEC-0001').entry.status).toBe('superseded');
    expect(store.getOracleEntry('DEC-0002').entry.status).toBe('active');

    // Re-refine (architect's own function, not a verb — §4 "Ticket":
    // "unchanged -> ready"): every staled ticket goes back to ready.
    for (const id of published.oracle.stale) {
      const result = await reRefineStale(store, id, { kind: 'unchanged' }, { by: 'architect' });
      expect(result.parent.status).toBe('ready');
    }
    for (const id of published.oracle.stale) {
      expect(store.getTicket(id).status).toBe('ready');
    }

    await client.close();
  });
});

describe('runDiscoveryProtocol — the one-call convenience path', () => {
  test('drives the same sequence end to end and reports every id touched', async () => {
    const result = await runDiscoveryProtocol(
      { store },
      {
        reporterTicket: 'TKT-0001',
        discovery: {
          tier: 'local',
          affects: ['DEC-0001'],
          proposed: 'DEC-0001 contradicts the new SSO requirement',
        },
        decisionEntry: {
          id: 'DEC-0002',
          title: 'Sessions are JWT',
          status: 'active',
          supersedes: ['DEC-0001'],
          depends: [],
          affects: ['DEC-0001'],
          decided: '2026-09-09',
          by: 'architect',
          rationale: 'SSO',
        },
        decisionBody: 'Sessions switch to JWT.',
      },
    );

    expect(result.tier).toBe('global');
    expect(result.haltId).not.toBeNull();
    expect(new Set(result.staled)).toEqual(new Set(['TKT-0001', 'TKT-0002', 'TKT-0003']));
    expect(new Set(result.reRefined)).toEqual(new Set(result.staled));
    expect(store.listHalts()).toHaveLength(0);
    for (const id of result.staled) {
      expect(store.getTicket(id).status).toBe('ready');
    }
  });

  test('a local discovery short-circuits: no halt, no decision, no ripple', async () => {
    await store.putTicket(
      validateTicket({
        id: 'TKT-0009',
        title: 'Unrelated ticket',
        status: 'in_progress',
        oracle_refs: ['DEC-0003'],
        contract: { acceptance: ['x'] },
        history: [],
      }),
    );
    const result = await runDiscoveryProtocol(
      { store },
      {
        reporterTicket: 'TKT-0009',
        discovery: { tier: 'local', affects: [], proposed: 'just a typo' },
        decisionEntry: {
          id: 'DEC-0099',
          title: 'unused',
          status: 'active',
          supersedes: [],
          depends: [],
          affects: [],
          decided: '2026-09-09',
          by: 'architect',
          rationale: 'unused',
        },
        decisionBody: 'unused',
      },
    );
    expect(result.tier).toBe('local');
    expect(result.haltId).toBeNull();
    expect(result.staled).toEqual([]);
    expect(() => store.getOracleEntry('DEC-0099')).toThrow();
  });
});
