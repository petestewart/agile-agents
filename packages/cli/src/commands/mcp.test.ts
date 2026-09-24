import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_VERBS } from '@agile-agents/shared';
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
  test('speaks MCP over stdio and publishes exactly the eight verbs', async () => {
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
