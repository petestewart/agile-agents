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
import {
  type AgentId,
  type AgentRecord,
  MESSAGE_BODY_MAX_CHARS,
  type Message,
  type SessionRole,
} from '@agile-agents/shared';
import type { Bus } from '../bus';
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
  /**
   * T125: optional. The daemon no longer derives a repo root from its own
   * cwd (`config.ts`), so this is only set by a caller that genuinely has
   * one in hand. Without it a *relative* `worktree` on an agent record
   * cannot be resolved, and the hook fails closed — the call is
   * unattributable and denied with `UNRESOLVED_CWD_REASON`, same as any
   * other cwd this daemon can't place. T130/T131 re-key agent records to
   * their stream's registered repo, at which point the resolution stops
   * needing a root at all.
   */
  repoRoot?: string;
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

const UNRESOLVED_CWD_REASON = 'agile: cwd is not a registered stream worktree';

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

/** What a hook call's `cwd` resolves to: the session, its stream, its role and its worktree (T130). */
export interface ResolvedHookIdentity {
  session: string;
  stream: string;
  role: SessionRole;
  worktreePath: string;
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

  /**
   * Resolves an absolute worktree path, `undefined`-safe. A relative path
   * needs a `repoRoot` to resolve against; without one (T125) it stays
   * unresolved rather than being resolved against the daemon's cwd, and the
   * caller treats that as "not a registered ticket worktree".
   */
  private absWorktree(worktree: string | undefined): string | undefined {
    if (worktree === undefined) return undefined;
    if (isAbsolute(worktree)) return worktree;
    const repoRoot = this.options.repoRoot;
    return repoRoot === undefined ? undefined : resolve(repoRoot, worktree);
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
  ): ResolvedHookIdentity | undefined {
    if (cwd === undefined) return undefined;
    const realCwd = safeRealpath(cwd);
    const now = this.now();

    const covering = this.store.listAgents().filter(({ record }) => {
      const worktreeAbs = this.absWorktree(record.worktree);
      return worktreeAbs !== undefined && isPathInside(realCwd, safeRealpath(worktreeAbs));
    });
    // The hint is the session's own identity (AGILE_AGENT from its
    // settings.json) and wins outright, stale record or not. Nineteenth
    // live run (2026-09-11): the engineer's record had gone stale while its
    // ticket sat in review; the stale filter below dropped it, the reviewer
    // sharing the worktree became the single candidate, and the engineer's
    // rebase was resolved — and halted — as the reviewer.
    const hinted = agentHint !== undefined ? covering.find((c) => c.id === agentHint) : undefined;
    const candidates = hinted
      ? [hinted]
      : covering.filter(({ record }) => !this.isStale(record, now));

    if (candidates.length > 0) {
      const chosen =
        candidates.length === 1 ? candidates[0] : candidates.find((c) => c.id === agentHint);
      // More than one candidate and no (matching) hint — fail closed rather
      // than guess which agent is really calling (this file's header).
      if (chosen === undefined) return undefined;
      const streamId = chosen.record.stream;
      // A registry entry with no stream cannot be placed (§8.1 step 1:
      // "resolve the session → stream → repo. Unresolvable ⇒ DENY").
      if (streamId === undefined) return undefined;
      // Always defined: `covering` only keeps records whose worktree this
      // resolved above. Fail closed rather than substitute a root.
      const worktreePath = this.absWorktree(chosen.record.worktree);
      if (worktreePath === undefined) return undefined;
      return {
        session: chosen.id,
        stream: streamId,
        role: chosen.record.role ?? 'worker',
        worktreePath,
      };
    }

    return undefined;
  }

  private async buildContext(
    cwd: string | undefined,
    agentHint?: string,
    // T022 round 2 fix (B1) — see `ClaudePreToolUsePayload.no_additional_context_channel`'s
    // doc comment: strips normal-priority messages out of the inbox handed
    // to `decidePreToolUse` so tier 3 never folds/acks them for a caller
    // with nowhere to put `additionalContext`.
    noAdditionalContextChannel = false,
  ): Promise<HookDecisionContext | undefined> {
    const resolved = this.resolveAgentByCwd(cwd, agentHint);
    if (resolved === undefined) return undefined;
    const { session, stream, role, worktreePath } = resolved;

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
      await this.store.heartbeat(session as AgentId, { stream }, this.now);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }

    return {
      session,
      stream,
      role,
      worktreePath,
      inbox: noAdditionalContextChannel
        ? this.bus.poll(session as AgentId).filter((m) => m.priority !== 'normal')
        : this.bus.poll(session as AgentId),
      limits: this.limits,
      fileSize: this.fileSize,
    };
  }

  /** Every hook decision is logged, deferred-commit (T009 review round, hot-path decision) — batched by the store rather than one `git commit` per tool call. */
  private async logDecision(
    ctx: { stream?: string; session?: string } | undefined,
    event: string,
    decision: HookDecision,
    detail: { tool?: string; command?: string } = {},
  ): Promise<void> {
    await this.store.appendEvent(
      buildEvent('hook_decision', {
        ...(ctx?.session !== undefined ? { agent: ctx.session as AgentId } : {}),
        data: {
          ...(ctx?.stream !== undefined ? { stream: ctx.stream } : {}),
          event,
          decision: decision.decision,
          reason: decision.reason,
          // What was refused, for post-mortems (a deny reason alone left a
          // live run's blocked commit unrecoverable from the log).
          ...(decision.decision !== 'allow' && detail.tool ? { tool: detail.tool } : {}),
          ...(decision.decision !== 'allow' && detail.command
            ? { command: detail.command.slice(0, MESSAGE_BODY_MAX_CHARS) }
            : {}),
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

  /**
   * `hook.pre_tool_use`. Review round fix (blocker 2): an unresolved `cwd`
   * is no longer a silent allow — it denies with a fixed reason and always
   * logs the decision (see this file's header).
   */
  async preToolUse(payload: ClaudePreToolUsePayload): Promise<PreToolUseHookOutput> {
    const ctx = await this.buildContext(
      payload.cwd,
      agentHintFrom(payload),
      payload.no_additional_context_channel === true,
    );
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
      // T121: an `ask` verdict used to open a durable `unblock` gate for
      // this ticket and tell the model to wait. `unblock` is deleted with
      // the rest of the ceremony gate kinds (cockpit design §3.1), and a
      // gate is now raised **on a stream**, which this ticket-keyed hook
      // has no way to name. Until T151 rebuilds this as the classifier
      // route band — a `classifier_review` inbox item on the stream, with
      // the session blocked until it is answered — an `ask` is a plain
      // deny that names the rule, which is the behaviour the model already
      // handles (`permissionDecisionReason` reaches it verbatim).
      const why = decision.reason ?? 'never-without-human command';
      decision = {
        ...decision,
        decision: 'deny',
        reason: `${why} — ask the operator on the stream before retrying`,
      };
    }

    await this.ackAll(ctx.session as AgentId, decision.ack);
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

    const low = this.bus.poll(ctx.session as AgentId, { priority: 'low' });
    if (low.length === 0) {
      await this.logDecision(ctx, 'stop', { decision: 'allow' });
      return {};
    }

    await this.ackAll(
      ctx.session as AgentId,
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
