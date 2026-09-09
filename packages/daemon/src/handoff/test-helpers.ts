/**
 * Shared test fixtures for `handoff/*.test.ts` — mirrors `em/test-helpers.ts`'s
 * `makeFixture`/`makeTicket`/`fakeRunner` shape, extended with a `stop()`
 * that actually mimics `runner/session.ts`'s exit handling (transitions the
 * ticket `in_progress -> ready`, same as a real session's `finish()`) —
 * `HandoffCoordinator` depends on that transition happening for its own
 * `waitReady` poll to ever resolve.
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

/**
 * A `Pick<Runner, 'spawn' | 'stop'>` fake: `spawn` mimics the real
 * `Runner.spawn`'s ticket transitions and worktree/assignee bookkeeping
 * (same as `em/test-helpers.ts`'s `fakeRunner`); `stop(agentId)` mimics
 * `runner/session.ts`'s `finish()` — transitions the ticket back to
 * `ready` when it's still in a live status, then drops the agent from
 * `live` — so `HandoffCoordinator.waitReady`'s poll loop resolves the same
 * way it would against a real session's exit event.
 */
export function fakeHandoffRunner(
  store: StateStore,
): Pick<Runner, 'spawn' | 'stop'> & { live: Set<AgentId>; spawnedProviders: Map<AgentId, string> } {
  const live = new Set<AgentId>();
  const ticketByAgent = new Map<AgentId, TicketId>();
  const spawnedProviders = new Map<AgentId, string>();

  return {
    live,
    spawnedProviders,
    async spawn(role, ticketId, opts): Promise<SpawnResult> {
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
      void opts?.extraContext; // observed via `spawnedProviders`/direct opts capture in tests that need it

      return {
        agentId,
        role,
        ticket: ticketId,
        worktree: `.worktrees/${ticketId}`,
        exited: new Promise(() => {
          // Real exit-driven cleanup is simulated synchronously by `stop()`.
        }),
        stop: () => {
          live.delete(agentId);
        },
      };
    },
    stop(agentId: AgentId): boolean {
      if (!live.has(agentId)) return false;
      live.delete(agentId);
      const ticketId = ticketByAgent.get(agentId);
      if (ticketId) {
        void (async () => {
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
        })();
      }
      return true;
    },
  };
}
