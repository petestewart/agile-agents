/**
 * `Runner` — `spawn(role, ticketId, opts)` / `list()` / `stop(agentId)` plus
 * the periodic liveness/redelivery sweep (T012 — design/
 * agile-agents-design.md §5 "Liveness": "`bus.heartbeat` rides on the
 * pre-tool-use hook ... `last_seen` older than N minutes ... daemon sends
 * `escalate` to em, ticket back to `ready`"; the ticket's own scope line:
 * "the bus's `checkLiveness`/`sweepRedelivery` still need a periodic caller
 * — that is yours").
 *
 * Agent id scheme (see `packages/shared/src/ids.ts`'s `AGENT_ID_PATTERN`):
 * for engineer/reviewer/qa the pattern is `eng-\d+` / `reviewer-\d+` /
 * `qa-\d+` — digits only after the dash, not a kebab slug. So the id is
 * `<rolePrefix>-<ticket digits>` (`TKT-0231` -> `eng-0231` / `reviewer-0231`
 * / `qa-0231`), one agent per (role, ticket) pair. Two ticket digits
 * colliding across different `TKT-` prefixes never happens (`TicketIdSchema`
 * is `TKT-\d{4,}` only), so this is unambiguous — but it does mean an
 * engineer, its reviewer, and its QA on the *same* ticket never collide with
 * each other (different prefixes), while a ticket being re-picked-up after a
 * crash reuses the exact same id (intentional: `store.getAgent`/
 * `deleteAgent` calls in `session.ts`'s exit handling and a fresh `spawn()`
 * afterward operate on the same registry entry). T031: the architect's id is
 * the literal `'architect'` (one per repo, §15), not a `role-\d+` family —
 * see `agentIdFor` below.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type AcpProviderConfig, resolveAcpProvider } from '@agile-agents/acp-client';
import type { AgentId, Ticket, TicketId } from '@agile-agents/shared';
import type { Bus } from '../bus';
import type { GateService } from '../gates';
import { installPreCommitHook } from '../merge/precommit';
import type { PermissionRole } from '../permissions';
import { wrapAgentCommand } from '../sandbox';
import type { StateStore } from '../store';
import { assembleBrief } from './brief';
import { type AgentSessionHandle, type AgentSessionOptions, startAgentSession } from './session';
import {
  INTEGRATION_BRANCH,
  ensureIntegrationBranch,
  ensureQaClone,
  ensureTicketWorktree,
  ticketDigits,
} from './worktrees';

const ROLE_PREFIX: Record<PermissionRole, string> = {
  engineer: 'eng',
  reviewer: 'reviewer',
  qa: 'qa',
  // Unused by `agentIdFor` below (architect short-circuits to the literal
  // singleton id before this table is ever consulted) — kept present only
  // so this stays an exhaustive `Record<PermissionRole, string>` (T031: a
  // new role must show up here, not be silently omitted).
  architect: 'architect',
};

/**
 * `<rolePrefix>-<ticket digits>` for engineer/reviewer/qa — see file
 * header. T031: the architect is a singleton, not a per-(role,ticket)
 * family (`AGENT_ID_PATTERN` in `packages/shared/src/ids.ts` has
 * `architect` as a literal alternative, the same way `em`/`human`/`daemon`
 * are, not a `role-\d+` family) — `ticket` is accepted (so
 * `Runner.spawn('architect', ticket)` still type-checks against the same
 * call shape every other role uses, and so an architect turn can still
 * carry a "currently focused ticket" for its brief/ledger context) but
 * ignored for id purposes: every call for role `'architect'` resolves to
 * the same bus address, matching design §15 "One architect per repo".
 */
export function agentIdFor(role: PermissionRole, ticket: TicketId): AgentId {
  if (role === 'architect') return 'architect' as AgentId;
  return `${ROLE_PREFIX[role]}-${ticketDigits(ticket)}` as AgentId;
}

/**
 * `.worktrees/architect`, a **detached** checkout of wherever `integration`
 * currently points (T031 — session override: "worktree placement: a
 * read-only checkout of `integration` at `.worktrees/architect`"), created
 * once and reused for every later architect spawn (the singleton id above
 * means there is only ever one). Detached rather than `git worktree add
 * path integration` (branch-checked-out, the way `ensureTicketWorktree`/
 * `ensureQaClone` check out their own dedicated branches): git refuses to
 * check the same branch out in two worktrees at once, and `integration`
 * is *also* what `MergeOwner.onTicketDone` needs its own dedicated
 * worktree on to actually merge tickets into (`merge/owner.ts`'s
 * `ensureNamedWorktree`) — a branch-checked-out architect worktree would
 * permanently starve every merge on this repo the moment it exists (found
 * running the offline e2e locally, not by inspection: `git worktree add`
 * on the already-checked-out branch fails with "already used by
 * worktree"). The architect never commits here anyway (it writes `.agile/`
 * state through MCP verbs, not this checkout, and "read-only" is enforced
 * by the permission/sandbox layers — §14's Architect row,
 * `permissions/policy-tables.ts`'s `architectVerdict` — not by git), so a
 * detached HEAD loses nothing: it just doesn't hold `integration`'s own
 * ref hostage. Reused as-is (no re-checkout) on later calls, same as every
 * other `ensure*Worktree` in this module — it can drift behind
 * `integration` as merges land, which is fine for a checkout the architect
 * never reads repo source out of.
 */
function ensureArchitectWorktree(repoRoot: string): string {
  const path = join(repoRoot, '.worktrees', 'architect');
  if (existsSync(path)) return path;

  ensureIntegrationBranch(repoRoot);
  mkdirSync(join(repoRoot, '.worktrees'), { recursive: true });
  const result = Bun.spawnSync(['git', 'worktree', 'add', '--detach', path, INTEGRATION_BRANCH], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `runner: failed to place the architect's read-only checkout of '${INTEGRATION_BRANCH}' at ${path}: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return path;
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
  /** T023: forwarded to every session — see `AgentSessionOptions.quota`. */
  quota?: AgentSessionOptions['quota'];
  /** ACP provider every session runs on. Defaults to Claude; vendor routing (T022) resolves this per ticket. */
  provider?: AcpProviderConfig;
  /** Test seam for the tier-0 sandbox pre-check + wrap (T026); defaults to the real `wrapAgentCommand`. */
  wrapCommand?: AgentSessionOptions['wrapCommand'];
  /** T022: forwarded to `startAgentSession` for a `pi`-routed spawn — test seam so a Pi-provider `Runner.spawn` test never touches the real `~/.pi/agent` (mirrors `session.test.ts`'s own seam of the same name). */
  piAgentDir?: AgentSessionOptions['piAgentDir'];
  /** T022: forwarded to `startAgentSession` — injects a fake `installPiExtension` for the same reason as `piAgentDir`. */
  installPiExtension?: AgentSessionOptions['installPiExtension'];
  /**
   * T031 review round 2 (opus blocker 2): forwarded to `startAgentSession`
   * for an architect spawn — see `AgentSessionOptions.architectMode`'s own
   * doc comment. Without this field CLAUDE.md's documented `default`-mode
   * fallback ("if plan mode blocks the architect's MCP writes, run
   * `default` mode with a daemon-side `approve_plan` gate") was reachable
   * only by a unit test calling `startAgentSession` directly, never by any
   * real `Runner.spawn('architect', ...)` caller or config. Defaults to
   * `'plan'` (via `startAgentSession`'s own default) when unset.
   */
  architectMode?: AgentSessionOptions['architectMode'];
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
   *
   * Provider selection (T022 round 2, review N1): `opts.provider`, when
   * given, wins outright (an explicit caller override — the injectable
   * seam the review asked for, and what `runner.test.ts`'s fake-ACP-agent
   * tests use to force a specific `AcpProviderConfig` without touching
   * `ticket.routing` at all). Otherwise resolved from `ticket.routing.vendor`
   * (`em/assign.ts`'s `assignReady` is what actually writes that field —
   * see its own doc comment), defaulting to Claude when unset via
   * `resolveAcpProvider`'s own `undefined` -> `'claude'` contract — so a
   * reviewer/QA spawn (routing is only ever written for the engineer role
   * today) is unaffected and still runs on Claude, matching this ticket's
   * "Pi engineers and a Claude reviewer" demo shape.
   */
  async spawn(
    role: PermissionRole,
    ticketId: TicketId,
    opts: {
      provider?: AcpProviderConfig;
      /**
       * T024 seam: appended to the assembled brief as a "Handoff context"
       * section — "starts in the same worktree with thread + handoff
       * stanza as context" (design §10 "Quota-driven pause and handoff").
       * `packages/daemon/src/handoff/**` is the only caller today; every
       * other spawn path (assignReady, a fresh QA/reviewer spawn) omits it
       * and the brief renders exactly as before this ticket.
       */
      extraContext?: string;
    } = {},
  ): Promise<SpawnResult> {
    const { store, bus, repoRoot } = this.opts;
    const agentId = agentIdFor(role, ticketId);
    if (this.live.has(agentId)) {
      throw new Error(`runner.spawn: ${agentId} is already running`);
    }

    let ticket = store.getTicket(ticketId);
    let worktreePath: string;

    // T026 tier-0 sandbox: the vendor's `requires_sandbox` /
    // `sandbox_enabled` flags come from `vendors.yaml`; a vendor the config
    // omits (or no config at all, pre-`agile init`) is treated as neither —
    // EXCEPT (T027 review round 1 B2) a provider whose bridge is measured
    // to have no gated exec at any tier (`ACP_PROVIDERS.<id>.requiresSandbox`
    // — Codex/Grok, design/spike-findings.md §C3) carries that fact on the
    // provider entry itself, ORed in here, so the refusal cannot be opted
    // out of by an operator's `vendors.yaml` simply omitting the field (the
    // schema default is `false`, and design §8's own example yaml never
    // sets it at all).
    // Per-spawn override > runner-wide default > the ticket's routed vendor
    // (T022; `resolveAcpProvider(undefined)` is Claude).
    const provider =
      opts.provider ?? this.opts.provider ?? resolveAcpProvider(ticket.routing?.vendor);
    const vendorConfig = this.vendorConfigFor(provider.id);
    const sandbox = {
      requiresSandbox:
        (provider.requiresSandbox ?? false) || (vendorConfig?.requires_sandbox ?? false),
      sandboxEnabled: vendorConfig?.sandbox_enabled ?? false,
    };
    const wrapCommand = this.opts.wrapCommand ?? wrapAgentCommand;

    if (role === 'engineer') {
      const result = ensureTicketWorktree(repoRoot, ticket);
      worktreePath = result.path;
      // Fail-closed pre-check (T026 report, wiring item 3): a
      // `requires_sandbox` vendor with no usable backend must be refused
      // *before* the ticket transitions to `assigned`/`in_progress`, or a
      // refused spawn would strand the ticket with no live agent. Same
      // `wrapAgentCommand` the session runs; it throws
      // `SandboxRequiredError` and is a no-op passthrough otherwise.
      wrapCommand({
        role,
        worktreePath,
        vendor: provider.id,
        command: provider.command,
        args: provider.args,
        requiresSandbox: sandbox.requiresSandbox,
        enabled: sandbox.sandboxEnabled,
        socketPath: this.opts.socketPath,
      });
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
    } else if (role === 'architect') {
      // T031: no ticket-state transition, worktree assignment, or
      // pre-commit hook install — the architect never edits `ticket` and
      // its checkout isn't a per-ticket branch (see `ensureArchitectWorktree`).
      worktreePath = ensureArchitectWorktree(repoRoot);
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
    // T024 seam (see this method's `opts.extraContext` doc comment above).
    const fullBrief = opts.extraContext
      ? `${brief}\n\n## Handoff context\n\n${opts.extraContext}\n`
      : brief;

    const handle = startAgentSession({
      store,
      bus,
      role,
      agentId,
      ticket: ticketId,
      worktreePath,
      brief: fullBrief,
      cliBin: this.opts.cliBin,
      socketPath: this.opts.socketPath,
      gateService: this.opts.gateService,
      spawn: this.opts.spawn,
      now: this.opts.now,
      quota: this.opts.quota,
      account: ticket.routing?.account,
      provider,
      requiresSandbox: sandbox.requiresSandbox,
      sandboxEnabled: sandbox.sandboxEnabled,
      wrapCommand: this.opts.wrapCommand,
      piAgentDir: this.opts.piAgentDir,
      installPiExtension: this.opts.installPiExtension,
      architectMode: this.opts.architectMode,
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

  /** `vendors.yaml` entry for an ACP provider id, or `undefined` when the config or the entry is absent. */
  private vendorConfigFor(vendorId: string) {
    try {
      return this.opts.store.getVendors()[vendorId];
    } catch {
      return undefined;
    }
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
   * True only if this *in-process* runner currently believes `agentId` is
   * live (T021 round 3 — the one honest liveness source for "should I
   * spawn a fresh session or reuse this one"). Deliberately never consults
   * `StateStore.getAgent`/`AgentRecord`: that record is durable and
   * survives a daemon restart (this file's own `list()` doc comment), so a
   * caller that inferred liveness from its mere presence would treat a
   * long-dead process as live and never spawn a real replacement — the
   * exact bug a round-2 attempt at this shipped and QA/opus review round 2
   * both caught by exercising it directly.
   */
  isLive(agentId: AgentId): boolean {
    return this.live.has(agentId);
  }

  /**
   * Sends a fresh turn to an already-live session (T021 round 3) — the
   * counterpart to `isLive`: a caller that finds an agent id still live
   * must talk to that same session again rather than re-`spawn`ing it
   * (which throws "already running"), and a session is otherwise only
   * ever prompted once, at spawn (`session.ts`'s own file header). Throws
   * if `agentId` isn't live — a caller should always check `isLive` (or
   * otherwise know the id is live) before calling this, the same
   * precondition `stop`/`list` place on their own callers.
   */
  async promptAgent(agentId: AgentId, text: string): Promise<unknown> {
    const handle = this.live.get(agentId);
    if (!handle) {
      throw new Error(`runner.promptAgent: ${agentId} is not live`);
    }
    return handle.prompt(text);
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
