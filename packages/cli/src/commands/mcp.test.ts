import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeAndEmit } from '@agile-agents/daemon';
import { AGENT_VERBS, type AgentId, ulid } from '@agile-agents/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { type TestDaemon, startTestDaemon } from '../test-support';

/** A well-formed session ULID that nothing is attached under. */
const SESSION = '01J9AAAAAAAAAAAAAAAAAAAAAA';

const CLI_ENTRY = join(import.meta.dir, '..', '..', 'src', 'index.ts');

let daemon: TestDaemon;
let client: Client;
let transport: StdioClientTransport;

beforeEach(async () => {
  daemon = await startTestDaemon('agile-cli-mcp-');
});

afterEach(async () => {
  await client?.close();
  await daemon.cleanup();
});

describe('agile mcp (stdio bridge, real CLI subprocess)', () => {
  test('speaks MCP over stdio and publishes exactly the verb table', async () => {
    transport = new StdioClientTransport({
      command: 'bun',
      args: [CLI_ENTRY, 'mcp', '--session', SESSION],
      env: { ...process.env, AGILE_SOCKET_PATH: daemon.socketPath },
    });
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...AGENT_VERBS].sort());
    // The model never supplies its own identity: `session` is fixed by the
    // bridge's own flag and is not part of any published schema.
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('session');
    }
  });

  test('`--socket <path>` reaches the daemon from a cwd whose own repo root is NOT where the socket lives, with no AGILE_SOCKET_PATH in the env', async () => {
    // The real spawn shape (`runner/session.ts`'s `mcpServerConfig`): the
    // bridge's cwd is a `.worktrees/**` checkout — a separate git repo root
    // from the daemon's — and the ACP MCP descriptor carries no env. Before
    // `--socket`, `discoverConfig` resolved the socket relative to that cwd,
    // the bridge died with `connect ENOENT <worktree>/.agile-daemon.sock`,
    // and every live session ran with zero daemon verbs (the first real
    // `test:live` run). This is the failing shape, made to pass only by the
    // explicit argument.
    const worktreeLike = mkdtempSync(join(tmpdir(), 'agile-cli-mcp-worktree-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: worktreeLike });
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'AGILE_SOCKET_PATH'),
      ) as Record<string, string>;
      transport = new StdioClientTransport({
        command: 'bun',
        args: [CLI_ENTRY, 'mcp', '--session', SESSION, '--socket', daemon.socketPath],
        cwd: worktreeLike,
        env,
      });
      client = new Client({ name: 'test-client', version: '0.0.0' });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('progress');
    } finally {
      rmSync(worktreeLike, { recursive: true, force: true });
    }
  });

  test('forwards a verb call to the daemon and returns its result', async () => {
    transport = new StdioClientTransport({
      command: 'bun',
      args: [CLI_ENTRY, 'mcp', '--session', SESSION],
      env: { ...process.env, AGILE_SOCKET_PATH: daemon.socketPath },
    });
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);

    const result = await client.callTool({ name: 'progress', arguments: { text: 'hello' } });
    // No session is attached under that id, so the daemon refuses — and the
    // refusal comes back as an MCP tool error, not a broken pipe or a
    // crashed bridge process.
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('unknown session');
  });
});

describe('read_event over MCP (T244)', () => {
  test("returns a routed event's payload and summary to a recipient, refuses anyone else", async () => {
    const parent = await daemon.streamService.create('human', { title: 'Shop', goal: 'shop' });
    const child = await daemon.streamService.create('human', {
      title: 'CSV',
      goal: 'csv',
      parent: parent.id,
    });
    const session = ulid();
    await daemon.store.putAgent(session as AgentId, {
      vendor: 'claude',
      model: 'sonnet',
      stream: parent.id,
      last_seen: new Date().toISOString(),
      role: 'worker',
    });
    const event = await routeAndEmit(
      daemon.routedEvents,
      {
        type: 'child_status',
        subject: child.id,
        by: 'daemon',
        payload: { child: child.id, title: 'CSV', status: 'blocked', progress: 'needs a key' },
      },
      daemon.streamService.list(),
    );
    transport = new StdioClientTransport({
      command: 'bun',
      args: [CLI_ENTRY, 'mcp', '--session', session],
      env: { ...process.env, AGILE_SOCKET_PATH: daemon.socketPath },
    });
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);

    const ok = await client.callTool({ name: 'read_event', arguments: { id: event.id } });
    expect(ok.isError).toBeFalsy();
    const body = JSON.parse((ok.content as Array<{ text: string }>)[0]?.text ?? 'null');
    expect(body.type).toBe('child_status');
    expect(body.payload.progress).toBe('needs a key');
    expect(body.summary).toBe('Child CSV is blocked: needs a key.');

    const other = ulid();
    const missing = await client.callTool({ name: 'read_event', arguments: { id: `E-${other}` } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain('no event');
  });
});

describe('lookup_knowledge over MCP (T263)', () => {
  test('returns the accepted items in scope for a path, not proposed or out-of-path ones', async () => {
    const node = await daemon.streamService.create('human', { title: 'Shop', goal: 'shop' });
    const session = ulid();
    await daemon.store.putAgent(session as AgentId, {
      vendor: 'claude',
      model: 'sonnet',
      stream: node.id,
      last_seen: new Date().toISOString(),
      role: 'worker',
    });
    const rules = daemon.rulesService;
    const scope = { kind: 'subtree' as const, node: node.id };
    const src = { by: 'human' as const };
    const everywhere = await rules.create('human', { text: 'use zod', scope, source: src });
    const api = await rules.create('human', {
      text: 'api returns problem+json',
      scope,
      paths: ['api/**'],
      source: src,
    });
    const ui = await rules.create('human', {
      text: 'ui uses tokens',
      scope,
      paths: ['ui/**'],
      source: src,
    });
    await rules.create('human', { text: 'still proposed', scope, source: src });
    for (const item of [everywhere, api, ui]) await rules.accept(item.id, 'human');

    transport = new StdioClientTransport({
      command: 'bun',
      args: [CLI_ENTRY, 'mcp', '--session', session],
      env: { ...process.env, AGILE_SOCKET_PATH: daemon.socketPath },
    });
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);

    const ok = await client.callTool({
      name: 'lookup_knowledge',
      arguments: { path: 'api/orders.ts' },
    });
    expect(ok.isError).toBeFalsy();
    const body = JSON.parse((ok.content as Array<{ text: string }>)[0]?.text ?? 'null');
    expect(body.path).toBe('api/orders.ts');
    expect(body.items.map((i: { text: string }) => i.text).sort()).toEqual([
      'api returns problem+json',
      'use zod',
    ]);
    expect(body.items.find((i: { text: string }) => i.text !== 'use zod').paths).toEqual([
      'api/**',
    ]);

    const dotted = await client.callTool({
      name: 'lookup_knowledge',
      arguments: { path: './api/orders.ts' },
    });
    expect(
      JSON.parse((dotted.content as Array<{ text: string }>)[0]?.text ?? 'null').items,
    ).toHaveLength(2);
    const outside = await client.callTool({
      name: 'lookup_knowledge',
      arguments: { path: '../x.ts' },
    });
    expect(outside.isError).toBe(true);

    const bad = await client.callTool({ name: 'lookup_knowledge', arguments: {} });
    expect(bad.isError).toBe(true);
  });
});
