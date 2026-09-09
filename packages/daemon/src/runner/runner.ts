/**
 * `Runner` — `spawn(role, ticketId, opts)` / `list()` / `stop(agentId)` plus
 * the periodic liveness/redelivery sweep (T012 — design/
 * agile-agents-design.md §5 "Liveness": "`bus.heartbeat` rides on the
 * pre-tool-use hook ... `last_seen` older than N minutes ... daemon sends
 * `escalate` to em, ticket back to `ready`"; the ticket's own scope line:
 * "the bus's `checkLiveness`/`sweepRedelivery` still need a periodic caller
 * — that is yours").
 *
 * Agent id scheme (DESIGN-GAP — see `packages/shared/src/ids.ts`'s
 * `AGENT_ID_PATTERN`, outside this ticket's file ownership): the pattern is
 * `eng-\d+` / `reviewer-\d+` / `qa-\d+` — digits only after the dash, not a
 * kebab slug. So the id is `<rolePrefix>-<ticket digits>` (`TKT-0231` ->
 * `eng-0231` / `reviewer-0231` / `qa-0231`), one agent per (role, ticket)
 * pair. Two ticket digits colliding across different `TKT-` prefixes never
 * happens (`TicketIdSchema` is `TKT-\d{4,}` only), so this is unambiguous —
 * but it does mean an engineer, its reviewer, and its QA on the *same*
 * ticket never collide with each other (different prefixes), while a ticket
 * being re-picked-up after a crash reuses the exact same id (intentional:
 * `store.getAgent`/`deleteAgent` calls in `session.ts`'s exit handling and a
 * fresh `spawn()` afterward operate on the same registry entry).
 */

import { join } from 'node:path';
import type { AgentId, Ticket, TicketId } from '@agile-agents/shared';
import type { Bus } from '../bus';
import type { GateService } from '../gates';
import { installPreCommitHook } from '../merge/precommit';
import type { PermissionRole } from '../permissions';
import type { StateStore } from '../store';
import { assembleBrief } from './brief';
import { type AgentSessionHandle, type AgentSessionOptions, startAgentSession } from './session';
import { ensureQaClone, ensureTicketWorktree, ticketDigits } from './worktrees';

const ROLE_PREFIX: Record<PermissionRole, string> = {
  engineer: 'eng',
  reviewer: 'reviewer',
  qa: 'qa',
};

/** `<rolePrefix>-<ticket digits>` — see file header. */
export function agentIdFor(role: PermissionRole, ticket: TicketId): AgentId {
  return `${ROLE_PREFIX[role]}-${ticketDigits(ticket)}` as AgentId;
}

/** Default periodic sweep cadence — CLAUDE.md doesn't name one for the sweep itself (only the 5min liveness *timeout* and 10min quorum timeout it drives); 30s matches the heartbeat tunable so a dead agent is caught within roughly one heartbeat interval of the liveness timeout elapsing. */
export const DEFAULT_SWEEP_INTERVAL_MS = 30 * 1000;

export interface RunnerOptions {
  store: StateStore;
  bus: Bus;
  /** Repo root — where `.worktrees/**` and the ticket's git branches live. */
  repoRoot: string;
  /** Path/name of the `agile` CLI binary passed to hook settings + MCP config. Defaults to `'agile'`. */
  cliBin?: string;
  /** `AGILE_SOCKET_PATH` threaded into every spawned session's worktree — needed whenever the daemon isn't using the default socket path a worktree would otherwise discover on its own. */
  socketPath?: string;
  gateService?: GateService;
  /** Test seam, forwarded to `startAgentSession` — the fake-agent helper's `spawnSession` stand-in. */
  spawn?: AgentSessionOptions['spawn'];
  now?: () => Date;
  /** Injectable so tests can drive the sweep without a real timer. */
  sweepIntervalMs?: number;
  /**
   * Installs the shared `pre-commit` halt guard (T019 `merge/precommit.ts`)
   * into every engineer worktree right after it is placed — hooks are the
   * enforcement layer, so this is on by default; a test may inject a no-op.
   */
  installPreCommitHook?: (worktreePath: string, ticket: Ticket) => unknown;
  /** T017: called once per QA spawn with the ticket and its fresh clone path — the daemon wires `QaProtocol.start` here. */
  onQaSpawn?: (ticket: Ticket, worktreePath: string) => unknown;
}

export interface SpawnResult {
  agentId: AgentId;
  role: PermissionRole;
  ticket: TicketId;
  /** Absolute path. */
  worktree: string;
  /** Resolves once the session has exited/crashed and cleanup has run — see `session.ts`'s `AgentExitInfo`. */
  exited: AgentSessionHandle['exited'];
  stop(): void;
}

export class Runner {
  private readonly live = new Map<AgentId, AgentSessionHandle>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: RunnerOptions) {}

  /**
   * Places the worktree, assembles the brief, and starts the ACP session.
   * Engineer: `.worktrees/<TKT-id>` off `integration`, ticket transitioned
   * `ready -> assigned -> in_progress` (whichever of those two edges still
   * apply — a ticket already `assigned` skips straight to the second, and
   * one already `in_progress` is a no-op — a fix cycle reusing the same
   * worktree). Reviewer: the *same* engineer worktree path, read-only ACP
   * policy (§12, CLAUDE.md v0 default) — the ticket must already carry a
   * `worktree` (an engineer has run at least once). QA: a fresh clone at
   * `.worktrees/<TKT-id>-qa` (§13).
   */
  async spawn(role: PermissionRole, ticketId: TicketId): Promise<SpawnResult> {
    const { store, bus, repoRoot } = this.opts;
    const agentId = agentIdFor(role, ticketId);
    if (this.live.has(agentId)) {
      throw new Error(`runner.spawn: ${agentId} is already running`);
    }

    let ticket = store.getTicket(ticketId);
    let worktreePath: string;

    if (role === 'engineer') {
      const result = ensureTicketWorktree(repoRoot, ticket);
      worktreePath = result.path;
      (this.opts.installPreCommitHook ?? installPreCommitHook)(worktreePath, ticket);
      const relWorktree = `.worktrees/${ticket.id}`;
      if (ticket.worktree !== relWorktree || ticket.assignee !== agentId) {
        ticket = await store.putTicket(
          { ...ticket, worktree: relWorktree, assignee: agentId },
          { by: agentId },
        );
      }
      // T012 QA round fix: a `ready` ticket must advance all the way to
      // `in_progress` on engineer spawn (design's assignment path,
      // `TICKET_TRANSITIONS`: `ready -> assigned -> in_progress` — no
      // direct `ready -> in_progress` edge exists, so this is two
      // transitions, not one). A ticket already `assigned` (the EM having
      // assigned it ahead of spawn) skips straight to the second.
      if (ticket.status === 'ready') {
        ticket = await store.transitionTicket(ticketId, 'assigned', { by: agentId });
      }
      if (ticket.status === 'assigned') {
        ticket = await store.transitionTicket(ticketId, 'in_progress', { by: agentId });
      }
    } else if (role === 'reviewer') {
      if (!ticket.worktree) {
        throw new Error(
          `runner.spawn: reviewer needs an engineer worktree on ${ticketId} first (ticket.worktree is unset)`,
        );
      }
      worktreePath = ensureTicketWorktree(repoRoot, ticket).path;
    } else {
      worktreePath = ensureQaClone(repoRoot, ticket).path;
      this.opts.onQaSpawn?.(ticket, worktreePath);
    }

    const brief = assembleBrief({
      store,
      stateRoot: join(repoRoot, '.agile'),
      role,
      agent: agentId,
      ticket,
    });

    const handle = startAgentSession({
      store,
      bus,
      role,
      agentId,
      ticket: ticketId,
      worktreePath,
      brief,
      cliBin: this.opts.cliBin,
      socketPath: this.opts.socketPath,
      gateService: this.opts.gateService,
      spawn: this.opts.spawn,
      now: this.opts.now,
    });
    this.live.set(agentId, handle);
    void handle.exited.then(() => {
      if (this.live.get(agentId) === handle) this.live.delete(agentId);
    });

    return {
      agentId,
      role,
      ticket: ticketId,
      worktree: worktreePath,
      exited: handle.exited,
      stop: () => handle.stop(),
    };
  }

  /** Every session this runner instance currently believes is live (in-process bookkeeping — a daemon restart loses this list; `store.listAgents()` is the durable source of truth). */
  list(): SpawnResult[] {
    return [...this.live.values()].map((handle) => ({
      agentId: handle.agentId,
      role: handle.role,
      ticket: handle.ticket,
      worktree: handle.worktree,
      exited: handle.exited,
      stop: () => handle.stop(),
    }));
  }

  /** `session.cancel()` + `session.close()` for a graceful stop. Does not itself transition the ticket or notify em — the session's own `exit` event drives that (same path a crash takes), so a graceful stop and a crash converge on one code path. */
  stop(agentId: AgentId): boolean {
    const handle = this.live.get(agentId);
    if (!handle) return false;
    handle.stop();
    return true;
  }

  /**
   * Calls `bus.checkLiveness()` + `bus.sweepRedelivery()` and reaps any
   * `this.live` entry whose ticket the liveness sweep just readied out from
   * under it (the agent's own process may still be technically alive but
   * unresponsive — `checkLiveness` already deleted its `AgentRecord` and
   * readied the ticket; stopping the in-process handle here keeps `list()`
   * from still reporting it).
   */
  async runSweep(): Promise<void> {
    const { bus } = this.opts;
    const escalations = await bus.checkLiveness();
    await bus.sweepRedelivery();
    for (const { agent } of escalations) {
      const handle = this.live.get(agent);
      if (handle) {
        handle.stop();
        this.live.delete(agent);
      }
    }
  }

  /** Starts the periodic sweep (unref'd — never keeps the process alive on its own). Idempotent: a second call replaces the previous timer. */
  startSweep(): void {
    this.stopSweep();
    const interval = this.opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const timer = setInterval(() => {
      void this.runSweep();
    }, interval);
    timer.unref?.();
    this.sweepTimer = timer;
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Stops every live session's underlying process (graceful) without waiting on their `exited` cleanup — for daemon shutdown. */
  stopAll(): void {
    this.stopSweep();
    for (const handle of this.live.values()) handle.stop();
  }
}
