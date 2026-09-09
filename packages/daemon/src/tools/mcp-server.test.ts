import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTicket } from '@agile-agents/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bus } from '../bus';
import { runInit } from '../init';
import { StateStore } from '../store';
import { createToolMcpServer } from './mcp-server';
import { loadToolRegistry } from './registry';
import { FakeRunner } from './runner';
import { ToolService } from './service';

let repo: string;
let store: StateStore;
let service: ToolService;
let runner: FakeRunner;
let client: Client;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-tool-mcp-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  const bus = new Bus(store, init.stateRoot);
  runner = new FakeRunner(() => ({
    text: JSON.stringify({ summary: 'a summary', refs: [] }),
    model: 'fake',
    inTokens: 1,
    outTokens: 1,
  }));
  service = new ToolService({
    store,
    bus,
    registry: loadToolRegistry(init.stateRoot),
    runner,
    repoRoot: repo,
  });
  writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');

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

  const server = createToolMcpServer(service, { agent: 'eng-1', ticket: 'TKT-0001' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('createToolMcpServer', () => {
  test('lists every tool (built-in verbs + registry tools)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
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

  test('calling read_summary twice: second call is a cache hit (runner invoked once)', async () => {
    const first = await client.callTool({ name: 'read_summary', arguments: { path: 'a.ts' } });
    expect(first.isError).not.toBe(true);
    const firstText = (first.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(JSON.parse(firstText)).toEqual({ summary: 'a summary', refs: [] });

    const second = await client.callTool({ name: 'read_summary', arguments: { path: 'a.ts' } });
    const secondText = (second.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(JSON.parse(secondText)).toEqual(JSON.parse(firstText));

    expect(runner.callCount).toBe(1);
  });

  test('review fix: read_summary and test_run publish real per-field input schemas, not an empty properties object', async () => {
    const { tools } = await client.listTools();
    const readSummary = tools.find((t) => t.name === 'read_summary');
    const testRun = tools.find((t) => t.name === 'test_run');
    expect(readSummary?.inputSchema.properties).toBeDefined();
    expect(Object.keys(readSummary?.inputSchema.properties ?? {}).sort()).toEqual([
      'path',
      'question',
    ]);
    expect(testRun?.inputSchema.properties).toBeDefined();
    expect(Object.keys(testRun?.inputSchema.properties ?? {}).sort()).toEqual(['command', 'cwd']);
  });

  test('review round 2 fix (blocker 2): kb_search rejects an unknown key over MCP, naming it', async () => {
    const result = await client.callTool({ name: 'kb_search', arguments: { scoep: 'daemon' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toMatch(/scoep/);
  });

  test('a tool error comes back as an MCP error result, not a thrown exception', async () => {
    const result = await client.callTool({ name: 'ticket_get', arguments: { id: 'TKT-9999' } });
    expect(result.isError).toBe(true);
  });

  test("board_post via MCP writes a stanza to the agent's own ticket", async () => {
    const result = await client.callTool({
      name: 'board_post',
      arguments: { kind: 'progress', summary: 'via mcp' },
    });
    expect(result.isError).not.toBe(true);
    expect(store.listStanzas('TKT-0001')).toHaveLength(1);
  });
});
