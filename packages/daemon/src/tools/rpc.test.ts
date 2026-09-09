import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { dispatch } from '../rpc';
import { StateStore } from '../store';
import { loadToolRegistry } from './registry';
import { buildToolRpcMethods } from './rpc';
import { FakeRunner } from './runner';
import { ToolService } from './service';

let repo: string;
let store: StateStore;
let methods: ReturnType<typeof buildToolRpcMethods>;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-tool-rpc-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  const bus = new Bus(store, init.stateRoot);
  const runner = new FakeRunner(() => ({
    text: JSON.stringify({ summary: 's', refs: [] }),
    model: 'fake',
    inTokens: 1,
    outTokens: 1,
  }));
  const service = new ToolService({
    store,
    bus,
    registry: loadToolRegistry(init.stateRoot),
    runner,
    repoRoot: repo,
  });
  methods = buildToolRpcMethods(service);

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
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('tool.* RPC via dispatch', () => {
  test('tool.list returns the built-ins + registry tools', async () => {
    const response = await dispatch(methods, { jsonrpc: '2.0', id: 1, method: 'tool.list' });
    const names =
      response && 'result' in response
        ? (response.result as Array<{ name: string }>).map((t) => t.name).sort()
        : [];
    expect(names).toContain('read_summary');
    expect(names).toContain('board_post');
  });

  test('tool.call routes to the tool and returns its result', async () => {
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tool.call',
      params: { agent: 'eng-1', ticket: 'TKT-0001', name: 'read_summary', input: { path: 'a.ts' } },
    });
    expect(response && 'result' in response ? response.result : undefined).toEqual({
      summary: 's',
      refs: [],
    });
  });

  test('tool.call rejects missing required params', async () => {
    const response = await dispatch(methods, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tool.call',
      params: { name: 'read_summary', input: {} },
    });
    expect(response && 'error' in response).toBe(true);
  });
});
