/**
 * Shared test fixtures for `handoff/*.test.ts` — mirrors `em/test-helpers.ts`'s
 * `makeFixture`/`makeTicket`/`fakeRunner` shape, extended with a `stop()`
 * that actually mimics `runner/session.ts`'s exit handling: it transitions
 * the ticket `in_progress -> ready` *and* only then resolves the spawned
 * session's own `exited` promise, with `live` cleared by a `.then` attached
 * at spawn time (before any external consumer's own await) — the same
 * ordering the real `Runner`/`session.ts` produce, and the one
 * `HandoffCoordinator.waitStopped` (round 2, opus B2) depends on.
 *
 * `exitDelayMs` (constructor option) simulates a slow-to-exit vendor CLI —
 * the ticket-ready transition and `exited`'s resolution both land after this
 * delay, decoupled from `stop()`'s own synchronous return, reproducing the
 * exact race the round 1 review measured against `waitReady`'s ticket-status
 * poll.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, Sprint, SprintId, Ticket, TicketId } from '@agile-agents/shared';
import { validateSprint, validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { agentIdFor } from '../runner';
import type { Runner, SpawnResult } from '../runner';
import { StateStore } from '../store';

export interface HandoffFixture {
  repo: string;
  stateRoot: string;
  store: StateStore;
  bus: Bus;
  cleanup: () => void;
}

export function makeHandoffFixture(): HandoffFixture {
  const repo = mkdtempSync(join(tmpdir(), 'agile-handoff-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  Bun.spawnSync(['git', 'branch', 'integration'], { cwd: repo });
  const init = runInit(repo);
  const store = StateStore.open(init.stateRoot);
  const bus = new Bus(store, init.stateRoot);
  return {
    repo,
    stateRoot: init.stateRoot,
    store,
    bus,
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}

export function makeTicket(id: TicketId, overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id,
    title: `Ticket ${id}`,
    status: 'ready',
    depends: [],
    contract: {},
    history: [],
    ...overrides,
  });
}

export function makeSprint(id: string, overrides: Partial<Sprint> = {}): Sprint {
  return validateSprint({
    id: id as SprintId,
    goal: `Sprint ${id}`,
    tickets: [],
    budget_tokens: 1_000_000,
    started: new Date().toISOString(),
    carried_over: [],
    ...overrides,
  });
}

export type FakeHandoffRunner = Pick<Runner, 'spawn' | 'stop' | 'list'> & {
  live: Set<AgentId>;
  spawnedProviders: Map<AgentId, string>;
};

/**
 * A `Pick<Runner, 'spawn' | 'stop' | 'list'>` fake — `spawn` mimics the real
 * `Runner.spawn`'s ticket transitions and worktree/assignee bookkeeping
 * (same as `em/test-helpers.ts`'s `fakeRunner`); `stop(agentId)`/`list()`
 * mimic `runner/session.ts`'s `finish()` + `Runner`'s own `live` bookkeeping
 * closely enough that `HandoffCoordinator.waitStopped` (round 2, opus B2)
 * exercises the real ordering: the ticket transitions to `ready`, *then*
 * `exited` resolves, and only *then* (via a `.then` registered at spawn
 * time, before any external consumer's own await) does `live` actually
 * drop the agent.
 */
export function fakeHandoffRunner(
  store: StateStore,
  opts: { exitDelayMs?: number } = {},
): FakeHandoffRunner {
  const live = new Set<AgentId>();
  const handles = new Map<AgentId, SpawnResult>();
  const ticketByAgent = new Map<AgentId, TicketId>();
  const spawnedProviders = new Map<AgentId, string>();
  const exitResolvers = new Map<AgentId, () => void>();
  const exitDelayMs = opts.exitDelayMs ?? 0;

  return {
    live,
    spawnedProviders,
    async spawn(role, ticketId, spawnOpts): Promise<SpawnResult> {
      const agentId = agentIdFor(role, ticketId);
      if (live.has(agentId)) {
        throw new Error(`fakeHandoffRunner: ${agentId} is already running`);
      }
      live.add(agentId);
      ticketByAgent.set(agentId, ticketId);

      let ticket = store.getTicket(ticketId);
      spawnedProviders.set(agentId, ticket.routing?.vendor ?? 'claude');
      if (ticket.status === 'ready') {
        ticket = await store.transitionTicket(ticketId, 'assigned', { by: agentId });
      }
      if (ticket.status === 'assigned') {
        ticket = await store.transitionTicket(ticketId, 'in_progress', { by: agentId });
      }
      if (ticket.worktree === undefined || ticket.assignee !== agentId) {
        await store.putTicket(
          { ...ticket, worktree: `.worktrees/${ticketId}`, assignee: agentId },
          { by: agentId },
        );
      }
      void spawnOpts?.extraContext; // observed via `spawnedProviders`/direct opts capture in tests that need it

      const exited = new Promise<Awaited<SpawnResult['exited']>>((resolve) => {
        exitResolvers.set(agentId, () =>
          resolve({ agentId, ticket: ticketId, reason: 'stopped', ticketReadied: true }),
        );
      });
      // Registered here, at spawn time — before any external consumer
      // (`HandoffCoordinator.waitStopped`) ever awaits this same promise —
      // so it always runs first once `exited` settles, exactly mirroring
      // `runner/runner.ts`'s own `void handle.exited.then(() => this.live.
      // delete(agentId))`.
      void exited.then(() => {
        live.delete(agentId);
        handles.delete(agentId);
      });

      const handle: SpawnResult = {
        agentId,
        role,
        ticket: ticketId,
        worktree: `.worktrees/${ticketId}`,
        exited,
        stop: () => {
          // Real stop() is driven through the outer `stop(agentId)` below —
          // this per-handle stop is unused by these tests but kept for
          // shape-parity with `SpawnResult`.
        },
      };
      handles.set(agentId, handle);
      return handle;
    },
    stop(agentId: AgentId): boolean {
      if (!live.has(agentId)) return false;
      const ticketId = ticketByAgent.get(agentId);
      void (async () => {
        if (exitDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, exitDelayMs));
        }
        if (ticketId) {
          try {
            const current = store.getTicket(ticketId);
            const LIVE_STATUSES = new Set([
              'assigned',
              'in_progress',
              'in_review',
              'in_qa',
              'blocked',
            ]);
            if (LIVE_STATUSES.has(current.status)) {
              await store.transitionTicket(ticketId, 'ready', { by: agentId, reason: 'stopped' });
            }
          } catch {
            // Ticket vanished — nothing to ripple back, same as the real finish().
          }
        }
        // Ticket is `ready` (or already moved on) *before* `exited`
        // resolves — same ordering `session.ts`'s `finish()` produces.
        exitResolvers.get(agentId)?.();
      })();
      return true;
    },
    list(): SpawnResult[] {
      return [...handles.values()];
    },
  };
}
