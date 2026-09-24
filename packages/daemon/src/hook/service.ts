/**
 * `HookService`: resolves a raw Claude hook payload into a
 * `HookDecisionContext`, runs the pure decision functions (`decide.ts`),
 * performs the side effects (ack, heartbeat, `hook_decision` event, route
 * band, thread entries) and renders Claude's hook JSON output (wire shape:
 * `design/spike-findings.md` §B).
 *
 * Attribution goes through the agent registry (`AgentRecord.worktree` and
 * `.role`), with both sides of every path comparison `realpath`d. Role comes
 * from the record, never inferred: a reviewer and a worker can share one
 * worktree, and resolving by path alone would answer the reviewer's calls
 * as the worker's. When several live records cover `cwd`, the payload's
 * `agile_agent` hint (the CLI forwards `AGILE_AGENT` from settings.json)
 * picks one; with no matching hint resolution fails closed. An unresolved
 * `cwd` is denied and logged, never allowed.
 */

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  type AgentId,
  type AgentMessage,
  type AgentRecord,
  type ClassifierConfig,
  type KnowledgeId,
  type KnowledgeItem,
  MESSAGE_BODY_MAX_CHARS,
  type Policy,
  type RepoEntry,
  type ReposConfig,
  type SessionRole,
  type Stream,
  THREAD_BODY_MAX_CHARS,
  validateClassifierConfig,
} from '@agile-agents/shared';
import type { Bus } from '../bus';
import { type Classifier, ClassifierUnavailableError, classifierEnabled } from '../classifier';
import type { RuleStatsOutcome } from '../knowledge/service';
import { isPathInside } from '../permissions/command';
import { worktreeBranchLookups } from '../permissions/push-detector';
import { patternRulesOf, protectedBranchesFor } from '../permissions/rule-checks';
import { NotFoundError, type StateStore, buildEvent } from '../store';
import {
  type ClassifierTierOutcome,
  buildClassifierState,
  classifierRulesOf,
  decideClassifierTier,
  decidePreToolUse,
} from './decide';
import { fingerprintCall } from './fingerprint';
import { type RouteBandGates, routeCall } from './route-band';
import {
  type ClaudePreToolUsePayload,
  DEFAULT_MAX_READ_BYTES,
  type HookDecision,
  type HookDecisionContext,
  type HookLimits,
} from './types';

/** Raw Claude `PostToolUse` payload. `agile_agent`: see `ClaudePreToolUsePayload` (a hint only). */
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

/** Raw Claude `Stop` payload. `agile_agent`: see `ClaudePreToolUsePayload` (a hint only). */
export interface ClaudeStopPayload {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  stop_hook_active?: boolean;
  agile_agent?: string;
  [key: string]: unknown;
}

/**
 * Claude's `PreToolUse` output (spike-findings.md §B). Always `allow` or
 * `deny` on the wire: `decide.ts`'s `ask` becomes a routed deny, because
 * Claude under ACP cannot answer an interactive `ask`.
 */
export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

/** Claude's `PostToolUse` hook cannot rewrite `tool_response`, so oversized output is only flagged via `additionalContext`. */
export interface PostToolUseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext?: string;
  };
}

/**
 * A `Stop` hook's `systemMessage` reaches the user, not the model; the way
 * to put text in front of the model is `decision: 'block'` + `reason`
 * (Claude re-prompts with it). So this blocks only when there are messages
 * to deliver, and acks them only then.
 */
export interface StopHookOutput {
  decision?: 'block';
  reason?: string;
}

export interface HookServiceOptions {
  /**
   * Resolves a *relative* `worktree` on an agent record. Without it such a
   * record cannot be placed and the call fails closed.
   */
  repoRoot?: string;
  /**
   * The route band (§8.1). With gates wired, a `hil` verdict raises a
   * `classifier_review` gate; without (unit tests) the call is denied and
   * the model told to ask on the stream, never allowed.
   */
  gates?: RouteBandGates;
  /** Pattern rules (§5.2, §5.4). Unset only in unit tests; `daemon.ts` always wires it. */
  rules?: HookRules;
  /**
   * The classifier tier (§6). The daemon wires it only when
   * `config.classifier` is configured; without it, classifier rules in
   * scope go through §6.4's fail policy like an outage.
   */
  classifier?: HookClassifier;
  limits?: HookLimits;
  /**
   * T227: told after every post-tool-use call of a tool that may change
   * files or commit (overlap tracking recomputes `touched`). Fire-and-forget.
   */
  onFilesMayHaveChanged?: (stream: string) => void;
  /** Injectable for tests; defaults to `node:fs.statSync`. */
  fileSize?: (path: string) => number | undefined;
  now?: () => Date;
}

/** The slice of `KnowledgeService` the hook needs. */
export interface HookRules {
  /** §5.3's one scope filter, for this session's stream. */
  inScope(streamId: string): KnowledgeItem[];
  /** §5.7's counters, bumped for every rule the decision evaluated. */
  recordFired(id: string, outcome: RuleStatsOutcome): Promise<unknown>;
}

/** The classifier tier as the hook needs it: something to ask, and the config the bands and the opt-out come from. */
export interface HookClassifier {
  ask: Classifier;
  config: ClassifierConfig;
  /** Env for the key lookup in `classifierEnabled`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable clock for the latency measurement. */
  now?: () => number;
}

/** The band defaults (§6.3), for a hook with no classifier wired at all — the fail policy still needs a band table to read. */
const DEFAULT_CLASSIFIER_CONFIG = validateClassifierConfig({});

function defaultFileSize(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

/** `realpath`, falling back to the resolved path when the target doesn't exist yet. Never throws. */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Tools that never change files or commit: no `touched` recompute after them (T227). */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']);

const UNRESOLVED_CWD_REASON = 'agile: cwd is not a registered stream worktree';

/** The `agile_agent` hint, written only by the CLI (from `AGILE_AGENT`); Claude's own payload never has it. */
function agentHintFrom(payload: Record<string, unknown>): string | undefined {
  return typeof payload.agile_agent === 'string' ? payload.agile_agent : undefined;
}

/** What a hook call's `cwd` resolves to. */
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
  /** Per stream, the session + body of the last hit appended: the coalescing key. */
  private readonly lastHit = new Map<string, string>();

  constructor(
    private readonly store: StateStore,
    private readonly bus: Bus,
    private readonly options: HookServiceOptions,
  ) {
    this.limits = options.limits ?? { maxReadBytes: DEFAULT_MAX_READ_BYTES };
    this.fileSize = options.fileSize ?? defaultFileSize;
    this.now = options.now ?? (() => new Date());
  }

  /** Resolves a worktree path; a relative one needs `repoRoot`, else it stays unresolved. */
  private absWorktree(worktree: string | undefined): string | undefined {
    if (worktree === undefined) return undefined;
    if (isAbsolute(worktree)) return worktree;
    const repoRoot = this.options.repoRoot;
    return repoRoot === undefined ? undefined : resolve(repoRoot, worktree);
  }

  /**
   * A record whose `last_seen` is older than the bus liveness timeout (or
   * unparseable) must not resolve a call: between an agent dying and the
   * sweep removing its record, it could otherwise authorize or
   * mis-disambiguate someone else's call.
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
    // The hint is the session's own identity and wins outright, stale or
    // not: a live run once dropped a worker's stale record here and resolved
    // its rebase as the reviewer sharing the worktree.
    const hinted = agentHint !== undefined ? covering.find((c) => c.id === agentHint) : undefined;
    const candidates = hinted
      ? [hinted]
      : covering.filter(({ record }) => !this.isStale(record, now));

    if (candidates.length > 0) {
      const chosen =
        candidates.length === 1 ? candidates[0] : candidates.find((c) => c.id === agentHint);
      // Several candidates and no matching hint: fail closed.
      if (chosen === undefined) return undefined;
      const streamId = chosen.record.stream;
      // A record with no stream cannot be placed (§8.1 step 1: unresolvable ⇒ deny).
      if (streamId === undefined) return undefined;
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
    // Strips normal-priority messages for a caller with no
    // `additionalContext` channel, so they are never folded in and acked.
    noAdditionalContextChannel = false,
  ): Promise<HookDecisionContext | undefined> {
    const resolved = this.resolveAgentByCwd(cwd, agentHint);
    if (resolved === undefined) return undefined;
    const { session, stream, role, worktreePath } = resolved;

    // Liveness heartbeat rides on every hook call (store-side coalesced to
    // 30 s). A covering record may have been removed since resolution;
    // nothing to update then.
    try {
      await this.store.heartbeat(session as AgentId, { stream }, this.now);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }

    const branches = worktreeBranchLookups(worktreePath);
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
      // Both git lookups are lazy and memoized: an ordinary call spawns none.
      patternRules: this.patternRulesFor(stream),
      protectedBranches: protectedBranchesFor(this.store, stream),
      upstreamBranch: branches.upstream,
      headBranch: branches.head,
      ...this.visibilityFor(stream, worktreePath),
    };
  }

  /** P13's inputs: the node's repo and project, and the registry. An unreadable repos.yaml fails closed (`reposError`). */
  private visibilityFor(
    stream: string,
    worktreePath: string,
  ): Pick<HookDecisionContext, 'visibility'> {
    const record = this.streamRecord(stream);
    let repos: ReposConfig = {};
    let reposError: string | undefined;
    try {
      repos = this.store.getRepos();
    } catch (err) {
      reposError = err instanceof Error ? err.message : String(err);
    }
    return {
      visibility: {
        repos,
        ...(reposError !== undefined ? { reposError } : {}),
        worktreePath,
        ...(record?.repo !== undefined ? { ownRepo: record.repo } : {}),
        ...(record?.project !== undefined ? { project: record.project } : {}),
      },
    };
  }

  /** The accepted pattern rules in scope for this stream (§5.3). */
  private patternRulesFor(stream: string): KnowledgeItem[] {
    return patternRulesOf(this.rulesInScope(stream));
  }

  /** §5.7's counters for every rule this decision evaluated — `stats.fired`, plus `violated` for the one it denied on. */
  private async recordRuleStats(decision: HookDecision): Promise<void> {
    const rules = this.options.rules;
    if (rules === undefined || decision.rulesEvaluated === undefined) return;
    for (const id of decision.rulesEvaluated) {
      try {
        const outcome =
          id === decision.ruleViolated
            ? 'violated'
            : id === decision.ruleRouted
              ? 'routed'
              : 'fired';
        await rules.recordFired(id, outcome);
      } catch {
        // A counter is telemetry: losing one must not fail a decision.
      }
    }
  }

  /** Every hook decision is logged. */
  private async logDecision(
    ctx: { stream?: string; session?: string } | undefined,
    event: string,
    decision: HookDecision,
    detail: {
      tool?: string;
      command?: string;
      allowedBy?: string;
      rule?: string;
      /** T169: the thread already shows this exact hit; the repeat is counted here instead. */
      repeat?: boolean;
    } = {},
  ): Promise<void> {
    await this.store.appendEvent(
      buildEvent('hook_decision', {
        ...(ctx?.session !== undefined ? { agent: ctx.session as AgentId } : {}),
        data: {
          ...(ctx?.stream !== undefined ? { stream: ctx.stream } : {}),
          event,
          decision: decision.decision,
          reason: decision.reason,
          // What was refused, for post-mortems.
          ...(decision.decision !== 'allow' && detail.tool ? { tool: detail.tool } : {}),
          ...(decision.decision !== 'allow' && detail.command
            ? { command: detail.command.slice(0, MESSAGE_BODY_MAX_CHARS) }
            : {}),
          // Allowed because a human approved the gate that blocked it.
          ...(detail.allowedBy !== undefined ? { allowed_by: detail.allowedBy } : {}),
          // Which rule refused the call: "why was I denied" from the log alone.
          ...(detail.rule !== undefined ? { rule: detail.rule } : {}),
          ...(detail.repeat === true ? { thread_repeat: true } : {}),
        },
      }),
    );
  }

  private async ackAll(agent: AgentId, ids: string[] | undefined): Promise<void> {
    for (const id of ids ?? []) {
      try {
        await this.bus.ack(agent, id);
      } catch {
        // Already acked or raced a concurrent ack: delivered either way.
      }
    }
  }

  /** `hook.pre_tool_use`. An unresolved `cwd` is denied and logged. */
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
    let allowedBy: string | undefined;
    let wasRouted = false;
    if (decision.decision === 'ask') {
      wasRouted = true;
      // The route band (§8.1): `ask` never reaches the wire. It becomes a
      // `classifier_review` gate plus a deny the model can act on, and the
      // human's yes lets exactly that call through once (`route-band.ts`).
      const why = decision.reason ?? 'never-without-human call';
      const routed = await this.route(ctx, payload, why);
      decision = { ...decision, ...routed.decision };
      allowedBy = routed.allowedBy;
    }

    // 3. The classifier tier (§8.1 step 3), only for a call the tiers above
    // allowed: a settled call is not worth a round trip.
    if (decision.decision === 'allow') {
      const tier = await this.classifierTier(ctx, payload);
      if (tier !== undefined) {
        const applied = await this.applyClassifierTier(ctx, payload, tier, decision);
        if (tier.outcome.band === 'route') wasRouted = true;
        decision = { ...decision, ...applied.decision };
        allowedBy = applied.allowedBy ?? allowedBy;
      }
    }

    await this.ackAll(ctx.session as AgentId, decision.ack);
    await this.recordRuleStats(decision);
    const repeat = await this.noteHit(ctx, payload, decision, wasRouted);
    await this.logDecision(ctx, 'pre_tool_use', decision, {
      ...(repeat ? { repeat: true } : {}),
      ...(payload.tool_name !== undefined ? { tool: payload.tool_name } : {}),
      ...(typeof payload.tool_input?.command === 'string'
        ? { command: payload.tool_input.command }
        : {}),
      ...(allowedBy !== undefined ? { allowedBy } : {}),
      ...(decision.ruleViolated !== undefined ? { rule: decision.ruleViolated } : {}),
    });

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
   * §8.1 step 3: one classifier call for the rules in scope, §6.3's bands.
   * `undefined` when no classifier rule is in scope (the common, free
   * case). The opt-out and a missing key go through the same fail policy as
   * an outage (§6.4), by failing with `not_configured`.
   */
  private async classifierTier(
    ctx: HookDecisionContext,
    payload: ClaudePreToolUsePayload,
  ): Promise<{ outcome: ClassifierTierOutcome; called: boolean } | undefined> {
    const rules = classifierRulesOf(this.rulesInScope(ctx.stream));
    if (rules.length === 0) return undefined;

    const tier = this.options.classifier;
    const enabled =
      tier !== undefined &&
      classifierEnabled({
        stream: this.streamRecord(ctx.stream),
        repo: this.repoEntry(ctx.stream),
        config: tier.config,
        ...(tier.env !== undefined ? { env: tier.env } : {}),
      });

    const state = buildClassifierState(
      { stream: ctx.stream, worktreePath: ctx.worktreePath, ...(this.repoOf(ctx.stream) ?? {}) },
      payload,
    );
    const classifier: Classifier =
      enabled && tier !== undefined
        ? tier.ask
        : {
            ask: () =>
              Promise.reject(
                new ClassifierUnavailableError(
                  'not_configured',
                  'the classifier tier is off for this stream',
                ),
              ),
          };
    const outcome = await decideClassifierTier({
      rules,
      bands: (tier?.config ?? DEFAULT_CLASSIFIER_CONFIG).bands,
      classifier,
      state,
      ...(tier?.now !== undefined ? { now: tier.now } : {}),
    });
    return { outcome, called: enabled };
  }

  /**
   * Turns a tier outcome into the model's decision, plus the
   * `classifier_call` event (§6.2), the `hook_unchecked` thread entry
   * (§6.4) and, for a route, the route band.
   */
  private async applyClassifierTier(
    ctx: HookDecisionContext,
    payload: ClaudePreToolUsePayload,
    tier: { outcome: ClassifierTierOutcome; called: boolean },
    /** The decision so far — its `rulesEvaluated` (the pattern tier's) is kept, not replaced. */
    soFar: HookDecision,
  ): Promise<{ decision: Partial<HookDecision>; allowedBy?: string }> {
    const { outcome } = tier;
    if (tier.called) await this.logClassifierCall(ctx, outcome);
    if (outcome.unchecked !== undefined) await this.noteUnchecked(ctx, outcome);

    const evaluated = [...(soFar.rulesEvaluated ?? []), ...outcome.evaluated];
    if (outcome.band === 'deny') {
      return {
        decision: {
          decision: 'deny',
          reason: outcome.reason,
          rulesEvaluated: evaluated,
          ...(outcome.rule !== undefined ? { ruleViolated: outcome.rule } : {}),
        },
      };
    }
    if (outcome.band === 'route') {
      const routed = await this.route(
        ctx,
        payload,
        outcome.reason ?? 'a classifier rule needs a human',
        outcome.rule as KnowledgeId | undefined,
      );
      return {
        decision: {
          ...routed.decision,
          rulesEvaluated: evaluated,
          // A spent approval means the human already said yes to this exact
          // call: it fired, it was not routed again.
          ...(routed.decision.decision !== 'allow' && outcome.rule !== undefined
            ? { ruleRouted: outcome.rule }
            : {}),
        },
        ...(routed.allowedBy !== undefined ? { allowedBy: routed.allowedBy } : {}),
      };
    }
    return { decision: { rulesEvaluated: evaluated } };
  }

  /** §6.2: "latency is recorded per call as an event". */
  private async logClassifierCall(
    ctx: HookDecisionContext,
    outcome: ClassifierTierOutcome,
  ): Promise<void> {
    await this.store.appendEvent(
      buildEvent('classifier_call', {
        agent: ctx.session as AgentId,
        data: {
          stream: ctx.stream,
          rules: outcome.evaluated.length,
          questions: outcome.questions,
          latency_ms: outcome.latency_ms,
          outcome: outcome.band,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        },
      }),
    );
  }

  /**
   * §6.4: the rules that went unchecked are marked on the stream's thread,
   * so "observed but unchecked" is visible rather than silent.
   */
  private async noteUnchecked(
    ctx: HookDecisionContext,
    outcome: ClassifierTierOutcome,
  ): Promise<void> {
    const rules = outcome.unchecked ?? [];
    if (rules.length === 0) return;
    const body =
      `hook_unchecked: the classifier could not answer (${outcome.error ?? 'no answer returned'}); ` +
      `${rules.length} non-critical rule(s) went unchecked and the call was allowed: ${rules.join(', ')}`;
    try {
      await this.store.appendThreadEntry(ctx.stream, {
        ts: this.now().toISOString(),
        by: 'daemon',
        kind: 'event',
        body: body.slice(0, THREAD_BODY_MAX_CHARS),
      });
    } catch {
      // The stream has gone or the write raced a close; the decision stands.
    }
  }

  /**
   * A refused or routed call is shown on the stream's thread: a rule hit
   * carries the rule id as `ref` (a "blocked by rule" card), a role-policy
   * deny gets a plain line. Best effort; the decision is already made.
   */
  private async noteHit(
    ctx: HookDecisionContext,
    payload: ClaudePreToolUsePayload,
    decision: HookDecision,
    routed: boolean,
  ): Promise<boolean> {
    if (decision.decision !== 'deny') return false;
    const ruleId = decision.ruleViolated ?? decision.ruleRouted;
    const outcome = routed ? 'routed to the human' : 'denied';
    const target = hitTarget(payload);
    let body: string;
    if (ruleId !== undefined) {
      const rule = this.rulesInScope(ctx.stream).find((each) => each.id === ruleId);
      const label = rule?.name !== undefined ? `${rule.name} (${ruleId})` : ruleId;
      body = `rule_hit: ${label} ${outcome} \`${target}\`${rule !== undefined ? ` — rule: ${rule.text}` : ''}`;
    } else {
      body = `hook_deny: ${outcome} \`${target}\` — ${decision.reason ?? 'role policy'}`;
    }
    const capped = body.slice(0, THREAD_BODY_MAX_CHARS);
    // Coalesce a retry storm: if the newest thread entry is this same hit
    // from the same session, append nothing and flag `thread_repeat` on the
    // event instead.
    const key = `${ctx.session}\u0000${capped}`;
    try {
      const last = this.store.readThread(ctx.stream).at(-1);
      if (
        last !== undefined &&
        last.by === 'daemon' &&
        last.kind === 'event' &&
        last.body === capped &&
        last.ref === ruleId &&
        this.lastHit.get(ctx.stream) === key
      ) {
        return true;
      }
    } catch {
      // Unreadable thread: fall through and try the append.
    }
    try {
      await this.store.appendThreadEntry(ctx.stream, {
        ts: this.now().toISOString(),
        by: 'daemon',
        kind: 'event',
        body: capped,
        ...(ruleId !== undefined ? { ref: ruleId } : {}),
      });
      this.lastHit.set(ctx.stream, key);
    } catch {
      // A stream that has gone: the decision is already made.
    }
    return false;
  }

  /** Every rule in scope for this stream, or none when no rules service is wired. */
  private rulesInScope(stream: string): KnowledgeItem[] {
    const rules = this.options.rules;
    if (rules === undefined) return [];
    try {
      return rules.inScope(stream);
    } catch {
      return [];
    }
  }

  private streamRecord(stream: string): Stream | undefined {
    try {
      return this.store.getStream(stream);
    } catch {
      return undefined;
    }
  }

  /** `{ repo }` for the state's stream/repo line, or nothing when the stream has none. */
  private repoOf(stream: string): { repo: string } | undefined {
    const repo = this.streamRecord(stream)?.repo;
    return repo === undefined ? undefined : { repo };
  }

  private repoEntry(stream: string): RepoEntry | undefined {
    const repo = this.streamRecord(stream)?.repo;
    if (repo === undefined) return undefined;
    try {
      return this.store.getRepos()[repo];
    } catch {
      return undefined;
    }
  }

  /** The route band for one `ask` verdict. No gates or no fingerprintable call: plain deny, never allow. */
  private async route(
    ctx: HookDecisionContext,
    payload: ClaudePreToolUsePayload,
    why: string,
    rule?: KnowledgeId,
  ): Promise<{ decision: HookDecision; allowedBy?: string }> {
    const gates = this.options.gates;
    const call = fingerprintCall(payload, ctx.worktreePath);
    if (gates === undefined || call === undefined) {
      return {
        decision: {
          decision: 'deny',
          reason: `${why} — ask the operator on the stream before retrying`,
        },
      };
    }
    let policy: Policy;
    try {
      policy = this.store.getPolicy();
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      // No `policy.yaml`: every gate is the human's (the shipped default).
      policy = {
        gates: { land: 'human', rule_accept: 'human', classifier_review: 'human' },
        breaker_signals: [],
      };
    }
    const routed = await routeCall(gates, {
      session: ctx.session,
      stream: ctx.stream,
      policy,
      call,
      reason: why,
      ...(rule !== undefined ? { rule } : {}),
    });
    return {
      decision: routed.decision,
      ...(routed.allowedBy !== undefined ? { allowedBy: routed.allowedBy } : {}),
    };
  }

  /**
   * `hook.post_tool_use`: logs usage and, for an oversized response, tells
   * the model via `additionalContext` (it cannot be truncated for Claude).
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
    if (!READ_ONLY_TOOLS.has(payload.tool_name ?? '')) {
      this.options.onFilesMayHaveChanged?.(ctx.stream);
    }

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
   * `hook.stop`: acks every low-priority message and re-prompts the model
   * with them (`block` + `reason`); an empty inbox returns `{}`.
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

function summarizeLowPriority(messages: AgentMessage[]): string {
  return messages.map((m) => `[${m.kind} from ${m.from}] ${m.body}`).join('\n');
}

/** What a hit refused (command, else path, else tool), one line, capped. */
function hitTarget(payload: ClaudePreToolUsePayload): string {
  const input = payload.tool_input ?? {};
  const pick = (key: string): string | undefined =>
    typeof input[key] === 'string' && (input[key] as string).length > 0
      ? (input[key] as string)
      : undefined;
  const raw =
    pick('command') ??
    pick('file_path') ??
    pick('path') ??
    pick('notebook_path') ??
    payload.tool_name ??
    'unknown call';
  const line = raw.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
