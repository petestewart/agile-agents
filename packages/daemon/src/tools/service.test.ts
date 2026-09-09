import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KbFact, OracleEntry, Ticket } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { StateStore } from '../store';
import { loadToolRegistry } from './registry';
import { FakeRunner } from './runner';
import { ToolService, UnknownToolError } from './service';

let repo: string;
let store: StateStore;
let bus: Bus;
let service: ToolService;
let runner: FakeRunner;

function makeTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id,
    title: `Ticket ${id}`,
    status: 'in_progress',
    contract: {},
    history: [],
    assignee: 'eng-1',
    ...overrides,
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-tool-service-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  bus = new Bus(store, init.stateRoot);
  runner = new FakeRunner(() => ({
    text: JSON.stringify({ summary: 'a summary', refs: [] }),
    model: 'fake',
    inTokens: 3,
    outTokens: 2,
  }));
  service = new ToolService({
    store,
    bus,
    registry: loadToolRegistry(init.stateRoot),
    runner,
    repoRoot: repo,
    currentSprintId: () => 'S-01',
  });

  writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('listTools', () => {
  test('lists the 5 built-in verbs and the 2 seeded registry tools', () => {
    const names = service
      .listTools()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(
      [
        'board_post',
        'bus_send',
        'kb_search',
        'oracle_get',
        'read_summary',
        'test_run',
        'ticket_get',
      ].sort(),
    );
  });
});

describe('callTool: read_summary + ledger', () => {
  test('a cache miss writes a ledger line with real token counts; a hit writes a zero-cost line', async () => {
    await store.putTicket(makeTicket('TKT-0001'));

    const first = await service.callTool({ agent: 'eng-1', ticket: 'TKT-0001' }, 'read_summary', {
      path: 'a.ts',
    });
    expect(first).toEqual({ summary: 'a summary', refs: [] });

    const second = await service.callTool({ agent: 'eng-1', ticket: 'TKT-0001' }, 'read_summary', {
      path: 'a.ts',
    });
    expect(second).toEqual(first);
    expect(runner.callCount).toBe(1);

    await store.flush();
    const ledger = store.listLedger('S-01');
    expect(ledger).toHaveLength(2);
    expect(ledger[0]?.kind).toBe('reader');
    expect(ledger[0]?.in_tokens).toBe(3);
    expect(ledger[1]?.in_tokens).toBe(0);
    expect(ledger[1]?.out_tokens).toBe(0);
  });

  test('unknown tool name throws UnknownToolError', async () => {
    await expect(service.callTool({ agent: 'eng-1' }, 'no_such_tool', {})).rejects.toThrow(
      UnknownToolError,
    );
  });
});

describe('callTool: test_run', () => {
  test('runs directly (no runner call) and writes a zero-model-cost ledger line', async () => {
    await store.putTicket(makeTicket('TKT-0002'));
    writeFileSync(
      join(repo, 'pkg.test.ts'),
      'import { test, expect } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n',
    );

    const result = (await service.callTool({ agent: 'eng-1', ticket: 'TKT-0002' }, 'test_run', {
      command: 'bun test pkg.test.ts',
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(runner.callCount).toBe(0);

    await store.flush();
    const ledger = store.listLedger('S-01');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.model).toBe('');
  });
});

describe('callTool: built-in verbs', () => {
  test('ticket_get reads a ticket', async () => {
    await store.putTicket(makeTicket('TKT-0003'));
    const result = await service.callTool({ agent: 'eng-1' }, 'ticket_get', { id: 'TKT-0003' });
    expect((result as Ticket).id).toBe('TKT-0003');
  });

  test('oracle_get reads a decision', async () => {
    const entry: OracleEntry = {
      id: 'DEC-0001',
      title: 'A decision',
      status: 'active',
      supersedes: [],
      depends: [],
      affects: [],
      decided: '2026-09-07',
      by: 'architect',
      rationale: 'because',
    };
    await store.putOracleEntry(entry, 'body text');
    const result = (await service.callTool({ agent: 'architect' }, 'oracle_get', {
      id: 'DEC-0001',
    })) as { entry: OracleEntry; body: string };
    expect(result.entry.id).toBe('DEC-0001');
    expect(result.body).toContain('body text');
  });

  test('kb_search filters the index by scope', async () => {
    const fact: KbFact = {
      id: 'KB-0001',
      kind: 'gotcha',
      scope: ['packages/daemon'],
      confidence: 'observed',
      source: 'TKT-0001',
      expires: null,
    };
    await store.putKbFact(fact, 'body');
    const hits = (await service.callTool({ agent: 'eng-1' }, 'kb_search', {
      scope: 'daemon',
    })) as Array<{ id: string }>;
    expect(hits.map((h) => h.id)).toEqual(['KB-0001']);

    const none = (await service.callTool({ agent: 'eng-1' }, 'kb_search', {
      scope: 'nowhere',
    })) as unknown[];
    expect(none).toEqual([]);
  });

  test('QA round 1 fix: kb_search rejects an unknown input key instead of silently ignoring it', async () => {
    await expect(
      service.callTool({ agent: 'eng-1' }, 'kb_search', { scoep: 'daemon' }),
    ).rejects.toThrow(/unknown input key/);
  });

  test('board_post: an engineer can post to its own ticket', async () => {
    await store.putTicket(makeTicket('TKT-0004'));
    const stanza = await service.callTool({ agent: 'eng-1', ticket: 'TKT-0004' }, 'board_post', {
      kind: 'progress',
      summary: 'made progress',
    });
    expect((stanza as { ticket: string }).ticket).toBe('TKT-0004');
    expect(store.listStanzas('TKT-0004')).toHaveLength(1);
  });

  test('board_post: a non-engineer is refused', async () => {
    await store.putTicket(makeTicket('TKT-0005'));
    await expect(
      service.callTool({ agent: 'reviewer-1', ticket: 'TKT-0005' }, 'board_post', {
        kind: 'progress',
        summary: 'x',
      }),
    ).rejects.toThrow();
  });

  test('board_post: an engineer cannot post to a ticket other than its own', async () => {
    await store.putTicket(makeTicket('TKT-0006'));
    await expect(
      service.callTool({ agent: 'eng-1', ticket: 'TKT-0006' }, 'board_post', {
        ticket: 'TKT-9999',
        kind: 'progress',
        summary: 'x',
      }),
    ).rejects.toThrow();
  });

  test('bus_send: from is always the calling agent, and routing is enforced', async () => {
    const result = (await service.callTool({ agent: 'em' }, 'bus_send', {
      to: ['architect'],
      kind: 'discovery',
      priority: 'normal',
      body: 'hello',
    })) as { message: { from: string } };
    expect(result.message.from).toBe('em');

    // engineer -> engineer is never allowed (§5 routing rules).
    await expect(
      service.callTool({ agent: 'eng-1' }, 'bus_send', {
        to: ['eng-2'],
        kind: 'question',
        priority: 'normal',
        body: 'hi',
      }),
    ).rejects.toThrow();
  });
});

// Manager wiring (T014 merge): role-scoped tool providers.
import {
  describe as describeProvider,
  expect as expectProvider,
  test as testProvider,
} from 'bun:test';

describeProvider('ToolService.registerProvider', () => {
  testProvider('a provider is listed and callable only for its roles', async () => {
    const { ToolService } = await import('./service');
    const { FakeRunner } = await import('./runner');
    const { runInit } = await import('../init');
    const { StateStore } = await import('../store');
    const { Bus } = await import('../bus');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const repo = mkdtempSync(join(tmpdir(), 'agile-provider-'));
    Bun.spawnSync(['git', 'init', '-q', repo]);
    Bun.spawnSync([
      'git',
      '-C',
      repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ]);
    const { stateRoot } = runInit(repo);
    const store = StateStore.open(stateRoot);
    const bus = new Bus(store, stateRoot);
    const service = new ToolService({
      store,
      bus,
      registry: [],
      runner: new FakeRunner(),
      repoRoot: repo,
    });
    const calls: string[] = [];
    service.registerProvider({
      roles: ['architect'],
      listTools: () => [{ name: 'ticket_point', description: 'x', inputSpec: {} }],
      callTool: async (ctx, name) => {
        calls.push(`${ctx.agent}:${name}`);
        return { ok: true };
      },
    });
    expectProvider(service.listTools('architect').some((t) => t.name === 'ticket_point')).toBe(
      true,
    );
    expectProvider(service.listTools('eng-tkt-0001').some((t) => t.name === 'ticket_point')).toBe(
      false,
    );
    expectProvider(await service.callTool({ agent: 'architect' }, 'ticket_point', {})).toEqual({
      ok: true,
    });
    await expectProvider(
      service.callTool({ agent: 'eng-tkt-0001' }, 'ticket_point', {}),
    ).rejects.toThrow();
    expectProvider(calls).toEqual(['architect:ticket_point']);
  });
});
