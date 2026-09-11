import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcpRequestId, AgentEvent, SpawnedSession } from '@agile-agents/acp-client';
import type { Policy } from '@agile-agents/shared';
import { GateService } from '../gates';
import { runInit } from '../init';
import { StateStore } from '../store';
import { runArchitectTurn } from './session';

let repo: string;
let store: StateStore;

const POLICY: Policy = { gates: { approve_plan: 'human' }, breaker_signals: [] };

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-architect-session-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** A minimal hand-built `SpawnedSession` — no fake-agent.ts subprocess needed: this module only reacts to `on(...)` frames and calls `respondPermission`/`prompt`/`cancel`/`close`, all of which a plain object can fake directly and deterministically. */
function fakeSpawnedSession() {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const responded: Array<{ id: AcpRequestId; result: unknown }> = [];
  let closed = false;
  const session: SpawnedSession = {
    prompt: async () => ({ stopReason: 'end_turn' }) as never,
    cancel: () => true,
    load: async () => ({}),
    setMode: async () => ({}),
    authenticate: async () => ({}),
    respondPermission: (id, result) => {
      responded.push({ id, result });
      return true;
    },
    respondPermissionError: () => true,
    on: (listener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    replay: () => ({ events: [], dropped: 0 }) as never,
    initialized: Promise.resolve({}),
    sessionId: 'fake-session',
    pid: 1234,
    get exited() {
      return closed;
    },
    close: () => {
      closed = true;
    },
  };
  return {
    session,
    emit: (event: AgentEvent) => {
      for (const l of listeners) l(event);
    },
    responded,
  };
}

describe('runArchitectTurn — approve_plan gate routing', () => {
  test('ExitPlanMode ("Approve Plan") request approved by a human respond() selects allow_once', async () => {
    const fake = fakeSpawnedSession();
    const gateService = new GateService(store);
    const handle = runArchitectTurn({
      gateService,
      policy: POLICY,
      cwd: repo,
      prompt: 'architect brief',
      mode: 'plan',
      spawn: () => fake.session,
      gatePollMs: 5,
    });

    fake.emit({
      type: 'event',
      event: {
        acp: 'request',
        id: 'req-1',
        method: 'session/request_permission',
        params: {
          toolCall: { kind: 'switch_mode', title: 'Approve Plan' },
          options: [
            { optionId: 'allow', kind: 'allow_once' },
            { optionId: 'reject', kind: 'reject_once' },
          ],
        },
      },
    } as unknown as AgentEvent);

    // Human answers the pending hil request directly.
    await Bun.sleep(10);
    const [pending] = gateService.list();
    if (!pending) throw new Error('expected a pending approve_plan gate request');
    await gateService.respond(pending.id, 'approve', 'human');

    await Bun.sleep(20);
    expect(fake.responded).toHaveLength(1);
    expect(fake.responded[0]?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });

    fake.emit({ type: 'exit', exitCode: 0 } as unknown as AgentEvent);
    const info = await handle.exited;
    expect(info.planApproved).toBe(true);
  });

  test('a rejected plan selects reject_once', async () => {
    const fake = fakeSpawnedSession();
    const gateService = new GateService(store);
    const handle = runArchitectTurn({
      gateService,
      policy: POLICY,
      cwd: repo,
      prompt: 'architect brief',
      mode: 'plan',
      spawn: () => fake.session,
      gatePollMs: 5,
    });

    fake.emit({
      type: 'event',
      event: {
        acp: 'request',
        id: 'req-1',
        method: 'session/request_permission',
        params: {
          toolCall: { kind: 'switch_mode', title: 'Approve Plan' },
          options: [
            { optionId: 'allow', kind: 'allow_once' },
            { optionId: 'reject', kind: 'reject_once' },
          ],
        },
      },
    } as unknown as AgentEvent);

    await Bun.sleep(10);
    const [pending] = gateService.list();
    if (!pending) throw new Error('expected a pending approve_plan gate request');
    await gateService.respond(pending.id, 'deny', 'human');

    await Bun.sleep(20);
    expect(fake.responded[0]?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });

    fake.emit({ type: 'exit', exitCode: 0 } as unknown as AgentEvent);
    const info = await handle.exited;
    expect(info.planApproved).toBe(false);
  });

  test('a non-plan permission request (edit/execute) is denied outright, never routed to the gate', async () => {
    const fake = fakeSpawnedSession();
    const gateService = new GateService(store);
    const handle = runArchitectTurn({
      gateService,
      policy: POLICY,
      cwd: repo,
      prompt: 'architect brief',
      mode: 'default',
      spawn: () => fake.session,
    });

    fake.emit({
      type: 'event',
      event: {
        acp: 'request',
        id: 'req-2',
        method: 'session/request_permission',
        params: {
          toolCall: { kind: 'edit', title: 'Edit some_file.ts' },
          options: [
            { optionId: 'allow', kind: 'allow_once' },
            { optionId: 'reject', kind: 'reject_once' },
          ],
        },
      },
    } as unknown as AgentEvent);

    expect(fake.responded).toHaveLength(1);
    expect(fake.responded[0]?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    expect(gateService.list()).toHaveLength(0);

    fake.emit({ type: 'exit', exitCode: 0 } as unknown as AgentEvent);
    await handle.exited;
  });
});
