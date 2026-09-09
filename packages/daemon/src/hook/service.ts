/**
 * `HookService` — resolves a raw Claude hook payload into a
 * `HookDecisionContext`, runs the pure decision functions (`decide.ts`),
 * performs the side effects the decision implies (ack, heartbeat, ledger,
 * `hook_decision` event, HIL requests), and renders Claude's actual hook
 * JSON output contract (T009 — design/agile-agents-design.md §6, §5, §4,
 * §7; wire shape verified against `design/spike-findings.md` §B and
 * `spike/spike-out/claude-default-perm-hooks.json`).
 *
 * Agent/ticket resolution (T012 QA/review round rewrite — see
 * `resolveAgentByCwd`): resolved primarily through the **agent registry**
 * (`AgentRecord.worktree`/`.role`, `bus/agents/<id>.yaml`) rather than
 * `Ticket.worktree` — the registry is what T012 actually sets correctly for
 * every role, QA included (a fresh clone at `.worktrees/<TKT>-qa` that never
 * matches `Ticket.worktree` at all, which is why QA hook calls were
 * hard-denied before this round). `Ticket.worktree` is kept only as a
 * fallback for a caller/test with no `AgentRecord` on file. Both sides of
 * every path comparison are `realpath`d first (review round fix: a
 * symlinked worktree must match either way it's addressed) via
 * `isPathInside` (reused from `permissions/command.ts`). Role comes from
 * the resolved `AgentRecord.role`, never inferred as `'engineer'` — critical
 * when a reviewer and an engineer share one physical worktree (§12,
 * CLAUDE.md v0 default): resolving by path alone would answer every hook
 * call in that shared directory as if it were the engineer, silently
 * defeating the reviewer's read-only tier-1 gate. When more than one
 * registered agent's worktree contains `cwd` (exactly the shared-worktree
 * case), the payload's `agile_agent` hint (set by `writeClaudeSettings`'s
 * `agentId` option — see `settings.ts` — and forwarded by the CLI from
 * `AGILE_AGENT`) disambiguates; with no hint, or a hint matching none of
 * the candidates, resolution fails closed (`undefined`) rather than
 * guessing.
 *
 * Review round fix (blocker 2): an unresolved `cwd` previously **failed
 * open** (`permissionDecision: 'allow'`) and logged nothing — a vendor hook
 * calling from anywhere the daemon can't place is exactly the case fail-
 * *closed* is supposed to cover, not the one exception to it. `preToolUse`
 * now denies with a fixed reason and always logs the decision (ticket/agent
 * `undefined` on the event, since none was resolved).
 */

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type {
  AgentId,
  AgentRecord,
  Message,
  Policy,
  Ticket,
  TicketId,
  TicketStatus,
} from '@agile-agents/shared';
import type { Bus } from '../bus';
import type { GateService } from '../gates';
import { activeHaltsFor } from '../halts';
import type { PermissionRole } from '../permissions';
import { isPathInside } from '../permissions/command';
import { NotFoundError, type StateStore, buildEvent } from '../store';
import { decidePreToolUse } from './decide';
import {
  type ClaudePreToolUsePayload,
  DEFAULT_MAX_READ_BYTES,
  type HookDecision,
  type HookDecisionContext,
  type HookLimits,
} from './types';

/** Raw Claude `PostToolUse` hook stdin payload. `agile_agent` — see `ClaudePreToolUsePayload`'s doc comment (`hook/types.ts`): a disambiguation hint only, applied after cwd resolution, never trusted alone. */
export interface ClaudePostToolUsePayload {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  agile_agent?: string;
  [key: string]: unknown;
}

/** Raw Claude `Stop` hook stdin payload. `agile_agent` — see `ClaudePreToolUsePayload`'s doc comment (`hook/types.ts`): a disambiguation hint only, applied after cwd resolution, never trusted alone. */
export interface ClaudeStopPayload {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  stop_hook_active?: boolean;
  agile_agent?: string;
  [key: string]: unknown;
}

/** Claude's `PreToolUse` hook output contract (spike-findings.md §B). `permissionDecision` is always `'allow' | 'deny'` on the wire out of this service — `decide.ts`'s `'ask'` is translated into a `deny` naming a durable HIL request before it ever reaches this shape (review/QA round: Claude under ACP cannot answer an interactive `ask`). */
export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

/** DESIGN-GAP: Claude's `PostToolUse` hook cannot rewrite `tool_response` (spike-findings.md §6 tier table only verifies this for Pi, not Claude) — so oversized output is never actually shrunk on the wire here, only flagged via `additionalContext` telling the model to prefer `test_run`/`read_summary` next time, alongside logging real usage every call. */
export interface PostToolUseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext?: string;
  };
}

/**
 * DESIGN-GAP (review round fix, blocker 4): the Claude `Stop` hook's own
 * documented output contract has no `additionalContext`/`systemMessage`
 * channel that reaches the *model* — `systemMessage` is shown to the
 * *user*, not fed back into the conversation, so acking low-priority
 * messages into it would silently drop them from the model's context while
 * still marking them delivered. The documented way to get text back in
 * front of the model from a `Stop` hook is `decision: 'block'` + `reason`
 * (Claude re-prompts the model with `reason` instead of ending the turn).
 * So: only when there is something to deliver does this return `block` +
 * the drained bodies as `reason`, and messages are acked **only in that
 * branch** (an empty inbox never blocks the turn just to say nothing).
 */
export interface StopHookOutput {
  decision?: 'block';
  reason?: string;
}

export interface HookServiceOptions {
  repoRoot: string;
  /** Never-without-human Bash commands need a durable HIL request (QA round: Claude can't answer an interactive `ask`) — see `resolveOrCreateHil`. */
  gates: GateService;
  limits?: HookLimits;
  /** Injectable for tests; defaults to `node:fs.statSync`. */
  fileSize?: (path: string) => number | undefined;
  now?: () => Date;
}

function defaultFileSize(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

/** `realpath`, falling back to the plain resolved path if the target doesn't exist yet (a freshly-created worktree dir mid-setup, or a test double) — never throws. */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** A ticket only resolves an active hook call while it's actually in flight — §4's live-status set (assigned/in_progress/in_review/in_qa), matching `bus.ts`'s own `LIVE_TICKET_STATUSES` reasoning for "an agent is really working this ticket right now". */
const LIVE_TICKET_STATUSES: readonly TicketStatus[] = [
  'assigned',
  'in_progress',
  'in_review',
  'in_qa',
];

const UNRESOLVED_CWD_REASON = 'agile: cwd is not a registered ticket worktree';
const UNBLOCK_GATE = 'unblock';

/**
 * Reads the disambiguation hint (T012 QA/review round — see this file's
 * header) off the raw hook payload: `agile_agent`, a field only the CLI
 * writes (from its own `process.env.AGILE_AGENT`, itself only set when
 * `writeClaudeSettings`'s `agentId` option embedded `AGILE_AGENT=<id>` into
 * the hook command) — Claude's own hook payload never carries this key, so
 * it's `undefined` for every hook config this daemon didn't write itself.
 */
function agentHintFrom(payload: Record<string, unknown>): string | undefined {
  return typeof payload.agile_agent === 'string' ? payload.agile_agent : undefined;
}

export class HookService {
  private readonly limits: HookLimits;
  private readonly fileSize: (path: string) => number | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly store: StateStore,
    private readonly bus: Bus,
    private readonly options: HookServiceOptions,
  ) {
    this.limits = options.limits ?? { maxReadBytes: DEFAULT_MAX_READ_BYTES };
    this.fileSize = options.fileSize ?? defaultFileSize;
    this.now = options.now ?? (() => new Date());
  }

  /** Resolves an absolute worktree path, `undefined`-safe, relative to `repoRoot`. */
  private absWorktree(worktree: string | undefined): string | undefined {
    if (worktree === undefined) return undefined;
    return isAbsolute(worktree) ? worktree : resolve(this.options.repoRoot, worktree);
  }

  /**
   * Finds the live-status ticket whose `worktree` (resolved against
   * `repoRoot`, both sides `realpath`d) contains `cwd` — the fallback path
   * for a caller/test with no `AgentRecord` on file (see this file's header).
   */
  private resolveTicketByCwd(cwd: string | undefined): Ticket | undefined {
    if (cwd === undefined) return undefined;
    const realCwd = safeRealpath(cwd);
    for (const ticket of this.store.listTickets()) {
      if (ticket.worktree === undefined || ticket.assignee === undefined) continue;
      if (!LIVE_TICKET_STATUSES.includes(ticket.status)) continue;
      const worktreeAbs = this.absWorktree(ticket.worktree);
      if (worktreeAbs !== undefined && isPathInside(realCwd, safeRealpath(worktreeAbs))) {
        return ticket;
      }
    }
    return undefined;
  }

  /**
   * Resolves `{agent, ticket, role, worktreePath}` from the payload's `cwd`
   * (registry-first — see this file's header) — or `undefined` if this call
   * can't be attributed to a known, live agent. `agentHint` (the payload's
   * `agile_agent` field, when the CLI forwarded `AGILE_AGENT`) disambiguates
   * when more than one registered agent's worktree contains `cwd`.
   */
  /**
   * Review round 3 (opus item 4): a stale registry entry (`last_seen`
   * older than the bus's own liveness timeout — CLAUDE.md tunable "liveness
   * timeout 5 min") must not win disambiguation, or even resolve alone.
   * The liveness sweep (`runner.ts`/`bus.ts`) removes a dead agent's record
   * eventually, but there's a real window between "the agent actually died"
   * and "the sweep noticed" where a stale-but-still-on-disk record could
   * otherwise authorize (or, worse, mis-disambiguate) a hook call that
   * isn't really coming from that agent any more. A record with an
   * unparseable `last_seen` is treated as stale too — fail safe, not "trust
   * a value we can't even read".
   */
  private isStale(record: AgentRecord, now: Date): boolean {
    const lastSeenMs = Date.parse(record.last_seen);
    if (Number.isNaN(lastSeenMs)) return true;
    return now.getTime() - lastSeenMs >= this.bus.getLivenessTimeoutMs();
  }

  private resolveAgentByCwd(
    cwd: string | undefined,
    agentHint: string | undefined,
  ): { agent: AgentId; ticket: TicketId; role: PermissionRole; worktreePath: string } | undefined {
    if (cwd === undefined) return undefined;
    const realCwd = safeRealpath(cwd);
    const now = this.now();

    const candidates = this.store.listAgents().filter(({ record }) => {
      const worktreeAbs = this.absWorktree(record.worktree);
      if (worktreeAbs === undefined || !isPathInside(realCwd, safeRealpath(worktreeAbs))) {
        return false;
      }
      return !this.isStale(record, now);
    });

    if (candidates.length > 0) {
      const chosen =
        candidates.length === 1 ? candidates[0] : candidates.find((c) => c.id === agentHint);
      // More than one candidate and no (matching) hint — fail closed rather
      // than guess which agent is really calling (this file's header).
      if (chosen === undefined) return undefined;
      const ticketId = chosen.record.ticket;
      if (ticketId === undefined) return undefined;
      try {
        const ticket = this.store.getTicket(ticketId);
        if (!LIVE_TICKET_STATUSES.includes(ticket.status)) return undefined;
      } catch {
        return undefined;
      }
      const worktreePath = this.absWorktree(chosen.record.worktree) ?? this.options.repoRoot;
      return {
        agent: chosen.id as AgentId,
        ticket: ticketId,
        role: chosen.record.role ?? 'engineer',
        worktreePath,
      };
    }

    // Fallback: no registered agent's worktree matches — the older
    // ticket-worktree-based resolution, engineer-only (no role signal
    // exists on `Ticket` itself).
    const ticket = this.resolveTicketByCwd(cwd);
    if (ticket === undefined || ticket.assignee === undefined) return undefined;
    return {
      agent: ticket.assignee as AgentId,
      ticket: ticket.id,
      role: 'engineer',
      worktreePath: this.absWorktree(ticket.worktree) ?? this.options.repoRoot,
    };
  }

  private async buildContext(
    cwd: string | undefined,
    agentHint?: string,
  ): Promise<HookDecisionContext | undefined> {
    const resolved = this.resolveAgentByCwd(cwd, agentHint);
    if (resolved === undefined) return undefined;
    const { agent, ticket: ticketId, role, worktreePath } = resolved;

    let ticket: Ticket;
    try {
      ticket = this.store.getTicket(ticketId);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }

    // Liveness heartbeat rides on the pre-tool-use hook (§5 "Liveness":
    // "bus.heartbeat rides on the pre-tool-use hook") — done here so every
    // hook event (not only pre-tool-use) keeps the registry warm. Goes
    // straight through the store's deferred, 30s-coalesced `heartbeat` (T009
    // review round, hot-path decision) rather than `Bus.heartbeat` (which
    // always writes+commits) — this is the per-tool-call hot path.
    //
    // Round 4 (QA round 3 REJECT — a real regression): `StateStore.heartbeat`
    // now ONLY ever touches `last_seen`/`ticket` and carries every other
    // field (`role`/`worktree`/`session_id` included) over from the existing
    // record verbatim — it used to reconstruct the whole record from just
    // this call's `{ ticket }` patch, silently dropping `role`/`worktree`
    // once `HEARTBEAT_COALESCE_MS` elapsed. That decayed a live reviewer or
    // QA session (one tool call roughly every 30+ seconds is normal) to
    // `resolveAgentByCwd`'s `role ?? 'engineer'` fallback mid-session — this
    // call site needs no change for the fix (it already only ever passed
    // `ticket`), the fix is entirely in `StateStore.heartbeat` so it can
    // never recur from any caller, this one included.
    //
    // `StateStore.heartbeat` now throws `NotFoundError` for an agent with no
    // registered `AgentRecord` at all (round 4: heartbeating an unregistered
    // agent is a caller bug, never a reason to fabricate one) — but
    // `resolveAgentByCwd`'s own backward-compat fallback (no `AgentRecord`,
    // resolved via `Ticket.worktree`/`.assignee` alone) is a legitimate,
    // tested path with no registry entry to heartbeat at all. That's not a
    // bug here, just nothing to update — swallow only that specific error.
    try {
      await this.store.heartbeat(agent, { ticket: ticketId }, this.now);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }

    return {
      agent,
      ticket: ticketId,
      role,
      worktreePath,
      halts: activeHaltsFor(this.store, ticketId),
      inbox: this.bus.poll(agent),
      ticketBudget: ticket.budget,
      limits: this.limits,
      fileSize: this.fileSize,
    };
  }

  /** Every hook decision is logged, deferred-commit (T009 review round, hot-path decision) — batched by the store rather than one `git commit` per tool call. */
  private async logDecision(
    ctx: { ticket?: TicketId; agent?: AgentId } | undefined,
    event: string,
    decision: HookDecision,
  ): Promise<void> {
    await this.store.appendEvent(
      buildEvent('hook_decision', {
        ticket: ctx?.ticket,
        agent: ctx?.agent,
        data: {
          event,
          decision: decision.decision,
          reason: decision.reason,
        },
      }),
      { commit: 'deferred' },
    );
  }

  private async ackAll(agent: AgentId, ids: string[] | undefined): Promise<void> {
    for (const id of ids ?? []) {
      try {
        await this.bus.ack(agent, id);
      } catch {
        // Already acked / raced with a concurrent ack — the delivery goal
        // ("the model has seen it") is met either way; nothing else to do.
      }
    }
  }

  /** `.agile/policy.yaml` may not exist (pre-T0xx-init repos, or a fixture that never seeded one) — an absent policy resolves every unnamed gate to `human` via `resolveGate`'s own default, so an empty policy is a safe stand-in, not a special case. */
  private loadPolicyOrDefault(): Policy {
    try {
      return this.store.getPolicy();
    } catch (err) {
      if (err instanceof NotFoundError) return { gates: {}, breaker_signals: [] };
      throw err;
    }
  }

  /**
   * Never-without-human Bash commands cannot be answered interactively —
   * Claude under ACP only ever sees this hook's stdout, so an `ask` verdict
   * from `decide.ts` is translated here into a **durable** `HIL-...`
   * request (QA round finding (g)/(h)) plus a `deny` naming it, rather than
   * a bare "ask a human" that leaves no record anywhere. Reuses a still-
   * `pending` `unblock` request already open for this ticket instead of
   * opening a second one for a retried/identical call — "no duplicate" per
   * the QA test.
   */
  private async resolveOrCreateHil(ticket: TicketId, agent: AgentId): Promise<string> {
    const existing = this.options.gates
      .list()
      .find((r) => r.status === 'pending' && r.ticket === ticket && r.gate === UNBLOCK_GATE);
    if (existing) return existing.id;

    const policy = this.loadPolicyOrDefault();
    const created = await this.options.gates.request(UNBLOCK_GATE, {
      policy,
      ticket,
      hilKind: 'unblock',
      from: agent,
    });
    return created.id;
  }

  /**
   * `hook.pre_tool_use`. Review round fix (blocker 2): an unresolved `cwd`
   * is no longer a silent allow — it denies with a fixed reason and always
   * logs the decision (see this file's header).
   */
  async preToolUse(payload: ClaudePreToolUsePayload): Promise<PreToolUseHookOutput> {
    const ctx = await this.buildContext(payload.cwd, agentHintFrom(payload));
    if (ctx === undefined) {
      await this.logDecision(undefined, 'pre_tool_use', {
        decision: 'deny',
        reason: UNRESOLVED_CWD_REASON,
      });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: UNRESOLVED_CWD_REASON,
        },
      };
    }

    let decision = decidePreToolUse(ctx, payload);
    if (decision.decision === 'ask') {
      const hilId = await this.resolveOrCreateHil(ctx.ticket, ctx.agent);
      decision = {
        ...decision,
        decision: 'deny',
        reason: `${decision.reason ?? 'never-without-human command'} — awaiting human approval, see ${hilId}`,
      };
    }

    await this.ackAll(ctx.agent, decision.ack);
    await this.logDecision(ctx, 'pre_tool_use', decision);

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.decision as 'allow' | 'deny',
        ...(decision.reason !== undefined ? { permissionDecisionReason: decision.reason } : {}),
        ...(decision.additionalContext !== undefined
          ? { additionalContext: decision.additionalContext }
          : {}),
      },
    };
  }

  /**
   * `hook.post_tool_use`. Truncation itself is not enforceable on the wire
   * for Claude (see `PostToolUseHookOutput`'s DESIGN-GAP) — this always
   * records real usage as a ledger line and, only when the response was
   * oversized, tells the model so via `additionalContext`.
   */
  async postToolUse(payload: ClaudePostToolUsePayload): Promise<PostToolUseHookOutput> {
    const ctx = await this.buildContext(payload.cwd, agentHintFrom(payload));
    if (ctx === undefined) return {};

    const responseText =
      typeof payload.tool_response === 'string'
        ? payload.tool_response
        : JSON.stringify(payload.tool_response ?? '');
    const bytes = Buffer.byteLength(responseText, 'utf8');
    const oversized = bytes > this.limits.maxReadBytes;

    let agentRecord: { model: string; vendor: string } | undefined;
    try {
      agentRecord = this.store.getAgent(ctx.agent);
    } catch {
      // No registry entry yet — ledger line still gets written with
      // "unknown", never skipped (usage must still be recorded).
    }

    let sprint = '';
    try {
      sprint = this.store.getTicket(ctx.ticket).sprint ?? '';
    } catch {
      // Ticket vanished between context resolution and here — sprint stays ''.
    }

    await this.store.appendLedgerLine(sprint, {
      ts: this.now().toISOString(),
      sprint,
      ticket: ctx.ticket,
      agent: ctx.agent,
      model: agentRecord?.model ?? 'unknown',
      in_tokens: 0,
      // Signal-over-volume rule (CLAUDE.md): tokens approximated by chars/4
      // (session brief), never the raw output itself.
      out_tokens: Math.ceil(responseText.length / 4),
      cost_usd: 0,
      kind: 'engineer',
    });

    const decision: HookDecision = oversized
      ? {
          decision: 'allow',
          additionalContext: `AGILE-GATE: this tool's output was ${bytes} bytes (over the ${this.limits.maxReadBytes}-byte cap) — prefer read_summary/test_run next time; raw output was not truncated on the wire (not enforceable for this vendor), but usage was recorded.`,
        }
      : { decision: 'allow' };
    await this.logDecision(ctx, 'post_tool_use', decision);

    return oversized
      ? {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: decision.additionalContext,
          },
        }
      : {};
  }

  /**
   * `hook.stop`. Drains (acks) every low-priority message in this agent's
   * inbox and re-prompts the model with them via `decision: 'block'` +
   * `reason` — only when there is something to deliver; an empty inbox
   * returns `{}` (never blocks the turn to say nothing) — see
   * `StopHookOutput`'s DESIGN-GAP.
   */
  async stop(payload: ClaudeStopPayload): Promise<StopHookOutput> {
    const ctx = await this.buildContext(payload.cwd, agentHintFrom(payload));
    if (ctx === undefined) return {};

    const low = this.bus.poll(ctx.agent, { priority: 'low' });
    if (low.length === 0) {
      await this.logDecision(ctx, 'stop', { decision: 'allow' });
      return {};
    }

    await this.ackAll(
      ctx.agent,
      low.map((m) => m.id),
    );
    const summary = summarizeLowPriority(low);
    await this.logDecision(ctx, 'stop', { decision: 'allow', additionalContext: summary });
    return { decision: 'block', reason: summary };
  }
}

function summarizeLowPriority(messages: Message[]): string {
  return messages.map((m) => `[${m.kind} from ${m.from}] ${m.body}`).join('\n');
}
