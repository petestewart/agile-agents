/**
 * `HookService` — resolves a raw Claude hook payload into a
 * `HookDecisionContext`, runs the pure decision functions (`decide.ts`),
 * performs the side effects the decision implies (ack, heartbeat, ledger,
 * `hook_decision` event), and renders Claude's actual hook JSON output
 * contract (T009 — design/agile-agents-design.md §6, §5, §4, §7; wire shape
 * verified against `design/spike-findings.md` §B and
 * `spike/spike-out/claude-default-perm-hooks.json`).
 *
 * Agent/ticket resolution (DESIGN-GAP, see `settings.ts`'s file header for
 * the full reasoning): the raw Claude hook payload's `cwd` field is matched
 * against every `Ticket.worktree` (resolved against `repoRoot`) via
 * `isPathInside` (reused from `permissions/command.ts` — the payload's cwd
 * can be the worktree root itself or a subdirectory Claude `cd`'d into).
 * The ticket's `assignee` is the resolved agent id; role is fixed to
 * `'engineer'` (this ticket's settings/hook wiring only targets engineer
 * worktrees per its Scope and Acceptance Criteria — reviewer/QA wiring is
 * out of scope here and would need a role signal this payload shape has no
 * field for).
 */

import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AgentId, Message, Ticket, TicketId } from '@agile-agents/shared';
import type { Bus } from '../bus';
import { activeHaltsFor } from '../halts';
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

/** Raw Claude `PostToolUse` hook stdin payload. */
export interface ClaudePostToolUsePayload {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  [key: string]: unknown;
}

/** Raw Claude `Stop` hook stdin payload. */
export interface ClaudeStopPayload {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

/** Claude's `PreToolUse` hook output contract (spike-findings.md §B). */
export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
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

/** DESIGN-GAP: the Claude `Stop` hook's own documented output contract is `decision: 'block'` (with `reason`) to prevent the turn from ending, or nothing to allow it — there is no documented `additionalContext` channel for Stop the way there is for PreToolUse/UserPromptSubmit. Draining low-priority inbox without blocking the turn is delivered via the contract's generic `systemMessage` field (shown to the user/logged, per Claude's hook docs, for every hook event) since Stop must never be turned into a block just to inject FYI content. */
export interface StopHookOutput {
  systemMessage?: string;
}

export interface HookServiceOptions {
  repoRoot: string;
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

  /** Finds the ticket whose `worktree` (resolved against `repoRoot`) contains `cwd`, or `undefined` if none matches. */
  private resolveTicketByCwd(cwd: string | undefined): Ticket | undefined {
    if (cwd === undefined) return undefined;
    for (const ticket of this.store.listTickets()) {
      if (ticket.worktree === undefined) continue;
      const worktreeAbs = isAbsolute(ticket.worktree)
        ? ticket.worktree
        : resolve(this.options.repoRoot, ticket.worktree);
      if (isPathInside(cwd, worktreeAbs)) return ticket;
    }
    return undefined;
  }

  /** Resolves `{agent, ticket}` from the payload's `cwd`, or `undefined` if this call can't be attributed to a known ticket/agent — see this file's header DESIGN-GAP. */
  private resolveAgentTicket(
    cwd: string | undefined,
  ): { agent: AgentId; ticket: TicketId } | undefined {
    const ticket = this.resolveTicketByCwd(cwd);
    if (ticket === undefined || ticket.assignee === undefined) return undefined;
    return { agent: ticket.assignee as AgentId, ticket: ticket.id };
  }

  private async buildContext(cwd: string | undefined): Promise<HookDecisionContext | undefined> {
    const resolved = this.resolveAgentTicket(cwd);
    if (resolved === undefined) return undefined;
    const { agent, ticket: ticketId } = resolved;

    let ticket: Ticket;
    try {
      ticket = this.store.getTicket(ticketId);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }

    const worktreePath = ticket.worktree
      ? isAbsolute(ticket.worktree)
        ? ticket.worktree
        : resolve(this.options.repoRoot, ticket.worktree)
      : this.options.repoRoot;

    // Liveness heartbeat rides on the pre-tool-use hook (§5 "Liveness":
    // "bus.heartbeat rides on the pre-tool-use hook") — done here so every
    // hook event (not only pre-tool-use) keeps the registry warm.
    await this.bus.heartbeat(agent, { ticket: ticketId });

    return {
      agent,
      ticket: ticketId,
      role: 'engineer',
      worktreePath,
      halts: activeHaltsFor(this.store, ticketId),
      inbox: this.bus.poll(agent),
      ticketBudget: ticket.budget,
      limits: this.limits,
      fileSize: this.fileSize,
    };
  }

  private async logDecision(
    ctx: HookDecisionContext | undefined,
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

  /**
   * `hook.pre_tool_use`. Unresolvable context (no ticket/agent match for
   * this `cwd`) is not a decision failure — it means this call isn't one
   * this ticket's engineer-hook wiring covers (see `settings.ts`'s
   * DESIGN-GAP), so it allows through with no reason to log.
   */
  async preToolUse(payload: ClaudePreToolUsePayload): Promise<PreToolUseHookOutput> {
    const ctx = await this.buildContext(payload.cwd);
    if (ctx === undefined) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    }

    const decision = decidePreToolUse(ctx, payload);
    await this.ackAll(ctx.agent, decision.ack);
    await this.logDecision(ctx, 'pre_tool_use', decision);

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.decision,
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
    const ctx = await this.buildContext(payload.cwd);
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

  /** `hook.stop`. Drains (acks) every low-priority message in this agent's inbox and reports them via `systemMessage` — see `StopHookOutput`'s DESIGN-GAP. */
  async stop(payload: ClaudeStopPayload): Promise<StopHookOutput> {
    const ctx = await this.buildContext(payload.cwd);
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
    return { systemMessage: summary };
  }
}

function summarizeLowPriority(messages: Message[]): string {
  return messages.map((m) => `[${m.kind} from ${m.from}] ${m.body}`).join('\n');
}
