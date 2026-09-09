import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Halt } from '@agile-agents/shared';
import { type RpcServerHandle, StateStore, runInit, startRpcServer } from '@agile-agents/daemon';
// DESIGN-GAP: `QuotaService`/`buildQuotaRpcMethods` (T023, `packages/daemon/
// src/quota/**`) are not yet re-exported from `@agile-agents/daemon`'s
// index.ts — that wiring is the manager's at merge (this ticket's file
// ownership excludes `daemon/src/index.ts`). Imported by subpath here so
// this test can exercise the real quota-wired status path today; switch to
// the package-root import once index.ts re-exports them.
import { QuotaService } from '@agile-agents/daemon/src/quota/records';
import { buildQuotaRpcMethods } from '@agile-agents/daemon/src/quota/rpc';
import { callRpc } from '../client';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { fetchStatus, printStatusHuman, runStatus, type StatusQuotaEntry } from './status';

let daemon: TestDaemon;

beforeEach(async () => {
  daemon = await startTestDaemon();
});

afterEach(async () => {
  await daemon.cleanup();
});

describe('fetchStatus', () => {
  test('reports daemon status and the ticket list, with agents/spend marked n/a (test daemon has no quota RPC wired)', async () => {
    await daemon.store.putTicket({
      id: 'TKT-0001',
      title: 'Test ticket',
      status: 'ready',
      contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
      depends: [],
      oracle_refs: [],
      kb_refs: [],
      history: [],
      security: false,
    });

    const status = await fetchStatus(daemon.socketPath);
    expect(status.daemon.pid).toBe(process.pid);
    expect(status.tickets).toHaveLength(1);
    expect(status.tickets[0]?.id).toBe('TKT-0001');
    expect(status.agents).toBe('n/a (no RPC yet)');
    expect(status.spend).toBe('n/a (no RPC yet)');
  });

  test('an empty ticket board reports an empty list, not an error', async () => {
    const status = await fetchStatus(daemon.socketPath);
    expect(status.tickets).toEqual([]);
    expect(status.halts).toEqual([]);
  });

  test('includes active halts (id, scope, quorum) so resume has a discovery path', async () => {
    const halt = await callRpc<Halt>(daemon.socketPath, 'state.halt_create', {
      scope: 'global',
      reason: 'seeded for status test',
      raised_by: 'human',
    });

    const status = await fetchStatus(daemon.socketPath);
    expect(status.halts).toHaveLength(1);
    expect(status.halts[0]?.id).toBe(halt.id);
    expect(status.halts[0]?.scope).toBe('global');
    expect(status.halts[0]?.quorum).toBeDefined();
  });
});

describe('runStatus', () => {
  test('json mode prints valid JSON with the expected shape', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      const code = await runStatus(daemon.socketPath, true);
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.daemon.pid).toBe(process.pid);
    expect(Array.isArray(parsed.tickets)).toBe(true);
    expect(Array.isArray(parsed.halts)).toBe(true);
  });

  test('human mode does not throw on an empty board', () => {
    expect(() =>
      printStatusHuman({
        daemon: { version: 'v', stateRoot: '/x', pid: 1, uptime: 0 },
        tickets: [],
        halts: [],
        agents: 'n/a (no RPC yet)',
        spend: 'n/a (no RPC yet)',
      }),
    ).not.toThrow();
  });

  test('human mode does not throw with a populated quota section', () => {
    const spend: StatusQuotaEntry[] = [
      {
        vendor: 'claude',
        account: 'max',
        remaining: 400_000,
        limit: 1_000_000,
        unit: 'tokens',
        confidence: 'estimated',
        cooldown_until: null,
      },
      {
        vendor: 'claude',
        account: 'pi',
        remaining: 1,
        unit: 'fraction',
        confidence: 'reported',
        cooldown_until: '2026-09-09T00:05:00.000Z',
        spend_usd: 2.5,
      },
    ];
    expect(() =>
      printStatusHuman({
        daemon: { version: 'v', stateRoot: '/x', pid: 1, uptime: 0 },
        tickets: [],
        halts: [],
        agents: 'n/a (no RPC yet)',
        spend,
      }),
    ).not.toThrow();
  });
});

describe('fetchStatus — with quota.* RPC wired (T023)', () => {
  let repo: string;
  let rpc: RpcServerHandle;
  let socketPath: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'agile-status-quota-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
    const init = runInit(repo);
    const store = StateStore.open(init.stateRoot);
    const quota = new QuotaService({ store });
    socketPath = join(repo, '.agile-daemon.sock');
    rpc = startRpcServer({
      socketPath,
      version: 'test',
      stateRoot: init.stateRoot,
      startedAt: Date.now(),
      extraMethods: {
        'state.ticket_list': () => store.listTickets(),
        'state.halt_list': () => store.listHalts(),
        ...buildQuotaRpcMethods(quota, store),
      },
    });
  });

  afterEach(async () => {
    await rpc.close();
    rmSync(repo, { recursive: true, force: true });
  });

  test('spend carries the real quota.list result once the RPC is wired', async () => {
    const status = await fetchStatus(socketPath);
    expect(Array.isArray(status.spend)).toBe(true);
    if (!Array.isArray(status.spend)) throw new Error('unreachable');
    expect(status.spend).toHaveLength(1);
    expect(status.spend[0]).toMatchObject({ vendor: 'claude', account: 'default' });
  });

  test('a 429 recorded through quota.record_429 shows up in the next fetchStatus', async () => {
    await callRpc(socketPath, 'quota.record_429', { vendor: 'claude', account: 'default', retryAfterSeconds: 60 });
    const status = await fetchStatus(socketPath);
    if (!Array.isArray(status.spend)) throw new Error('unreachable');
    expect(status.spend[0]?.cooldown_until).not.toBeNull();
  });
});
