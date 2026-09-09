/**
 * Shared test fixtures for `em/*.test.ts` — not a test file itself (bun test
 * only picks up `*.test.ts`), just the `mkdtempSync` + `runInit` +
 * `StateStore.open` boilerplate every other package module's tests
 * duplicate locally (`halts/index.test.ts`, `gates/service.test.ts`), plus a
 * fake `Runner` (`Pick<Runner, 'spawn'>`) so `assign.ts`/`loop.ts` tests
 * never need a real ACP session.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, Sprint, SprintId, Ticket, TicketId } from '@agile-agents/shared';
import { validateSprint, validateTicket } from '@agile-agents/shared';
import { runInit } from '../init';
import { type Runner, type SpawnResult, agentIdFor } from '../runner';
import { StateStore } from '../store';

export interface Fixture {
  repo: string;
  stateRoot: string;
  store: StateStore;
  cleanup: () => void;
}

export function makeFixture(): Fixture {
  const repo = mkdtempSync(join(tmpdir(), 'agile-em-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  const store = StateStore.open(init.stateRoot);
  return {
    repo,
    stateRoot: init.stateRoot,
    store,
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
 * A `Pick<Runner, 'spawn'>` that mimics the real `Runner.spawn`'s ticket
 * transitions (`ready -> assigned -> in_progress`) without a real ACP
 * session — the exact same edges `runner.ts`'s own doc comment describes.
 * Tracks "already live" the same way the real runner does (a second
 * `spawn()` on the same agent id throws), so `assignReady`'s
 * already-running skip path is exercised too.
 */
export function fakeRunner(store: StateStore): Pick<Runner, 'spawn'> & { live: Set<AgentId> } {
  const live = new Set<AgentId>();
  return {
    live,
    async spawn(role, ticketId): Promise<SpawnResult> {
      const agentId = agentIdFor(role, ticketId);
      if (live.has(agentId)) {
        throw new Error(`fakeRunner: ${agentId} is already running`);
      }
      live.add(agentId);

      let ticket = store.getTicket(ticketId);
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

      return {
        agentId,
        role,
        ticket: ticketId,
        worktree: `.worktrees/${ticketId}`,
        exited: new Promise(() => {
          // Never resolves in tests — nothing here ever "exits" on its own;
          // `stop()` below just marks it not-live so a re-spawn is possible.
        }),
        stop: () => {
          live.delete(agentId);
        },
      };
    },
  };
}
