import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Halt } from '@agile-agents/shared';
import { callRpc } from '../client';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { fetchStatus, printStatusHuman, runStatus } from './status';

let daemon: TestDaemon;

beforeEach(async () => {
  daemon = await startTestDaemon();
});

afterEach(async () => {
  await daemon.cleanup();
});

describe('fetchStatus', () => {
  test('reports daemon status and the ticket list, with agents/spend marked n/a', async () => {
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
});
