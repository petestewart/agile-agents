/**
 * `RulesService` — propose / read / list / accept / retire / edit a rule,
 * and the one scope filter (T140; cockpit design §5).
 *
 * Every method takes an explicit **principal**, exactly as `StreamService`
 * does (§2.2): the RPC edge stamps `human`, the `propose_rule` verb passes
 * `agent`, and the daemon's own writes (the built-ins of §5.4, T143, and
 * the hook's `stats` counters) pass `daemon`. The split itself is enforced
 * in the store, which is the only writer of `rules/`.
 *
 * `rulesInScope` (§5.3) lives here as a pure function and is exported for
 * its two callers — the brief assembler (`runner/brief.ts`) and the hook
 * (T143/T151). There is no second implementation and no per-caller
 * filtering logic: an out-of-scope rule cannot reach a brief or a hook
 * decision by a caller forgetting to filter.
 */

import {
  type Rule,
  type RuleInput,
  type RulePatch,
  type RulePrincipal,
  type RuleProposal,
  type RuleScope,
  type RuleStage,
  type RuleStatus,
  type Stream,
  formatRuleScope,
  ulid,
  validateRuleProposal,
} from '@agile-agents/shared';
import type { StateStore } from '../store/store';
import type { StreamService } from '../streams/service';

/** `rules/` in the state home — a sibling of `streams/` and `questions/` (§7.2). */
export const RULES_DIR = 'rules';

/**
 * A rule whose `scope.ref` names nothing in this home. Typed so the RPC
 * edge reports it as `invalid params` (-32602) — bad caller input, not an
 * internal fault, same as `UnknownRepoError` on the stream edge.
 */
export class UnknownRuleScopeError extends Error {
  constructor(
    public readonly scope: RuleScope,
    detail: string,
  ) {
    super(`unknown rule scope: ${scope.kind}:${String(scope.ref)} — ${detail}`);
    this.name = 'UnknownRuleScopeError';
  }
}

/** A decision on a rule that is already in that state (accepting an accepted rule). */
export class RuleAlreadyDecidedError extends Error {
  constructor(id: string, status: RuleStatus) {
    super(`rule ${id} is already ${status}`);
    this.name = 'RuleAlreadyDecidedError';
  }
}

export interface ListRulesOptions {
  status?: RuleStatus;
  /** `global` · `repo:<name>` · `stream:<id>` — the rendered scope, as the CLI takes it. */
  scope?: string;
}

export interface RulesServiceOptions {
  store: StateStore;
  streams: StreamService;
  /** Test seam; real usage runs on the system clock. */
  clock?: () => Date;
  /**
   * How often coalesced `stats` counters are written (T143). `0` disables
   * the timer entirely, leaving flush-on-read and flush-on-shutdown — which
   * is what a test that wants a deterministic flush point passes.
   */
  statsFlushMs?: number;
}

/**
 * The stats-flush interval. Counters are written at most this often per
 * rule, however many tool calls fired them: a gated tool call evaluates
 * every pattern rule in scope, and one YAML rewrite plus one `rule_put`
 * event per rule per call would make the state home's log mostly
 * bookkeeping. The `hook_decision` event stays per call — that is the
 * record of what was decided; `stats` are only §5.7's pruning input.
 */
export const DEFAULT_STATS_FLUSH_MS = 5_000;

/** Counters accumulated since the last flush, for one rule. */
interface PendingRuleStats {
  fired: number;
  violated: number;
  routed: number;
  last_fired_at: string;
}

/**
 * Design §5.3's one scope filter:
 *
 *     rulesInScope(stream) =
 *         all accepted rules with scope.kind = 'global'
 *       + accepted rules with scope {kind: 'repo', ref: stream.repo}
 *       + accepted rules with scope {kind: 'stream', ref: s}
 *         for s in [stream, ...ancestors(stream)]
 *
 * Mechanical, never a judgement call. `proposed` and `retired` rules are
 * never in scope, so retiring one stops it being injected on the next
 * session with no restart; a nested stream inherits its ancestors'
 * stream-scoped rules. `ancestors` is the chain the caller already has
 * (root→leaf or leaf→root — only membership is read).
 *
 * T152 adds the **stage** filter on the same function rather than beside
 * it, because §5.3 asks for one scope filter and nothing else: `stage`
 * selects the rules checked at a given point — `'action'` for the
 * per-tool-call hook (§8.1), `'diff'` for the check at landing (§8.2) — and
 * a rule with `stage: 'both'` matches either. Omitting it keeps every rule
 * in scope, which is what the brief assembler wants (guidance is injected
 * whatever stage it is checked at).
 */
export function rulesInScope(
  rules: readonly Rule[],
  stream: Stream,
  ancestors: readonly Stream[] = [],
  stage?: RuleStage,
): Rule[] {
  const streamIds = new Set<string>([stream.id, ...ancestors.map((a) => a.id)]);
  return rules.filter((rule) => {
    if (rule.status !== 'accepted') return false;
    if (stage !== undefined && rule.stage !== stage && rule.stage !== 'both') return false;
    if (rule.scope.kind === 'global') return true;
    if (rule.scope.ref === undefined) return false;
    if (rule.scope.kind === 'repo') return stream.repo === rule.scope.ref;
    return streamIds.has(rule.scope.ref);
  });
}

export class RulesService {
  private readonly clock: () => Date;
  private readonly statsFlushMs: number;
  /** Coalesced `stats` deltas, keyed by rule id — see `recordFired`. */
  private readonly pendingStats = new Map<string, PendingRuleStats>();
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  /** Serializes flushes so two of them never read the same `before` record. */
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly options: RulesServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.statsFlushMs = options.statsFlushMs ?? DEFAULT_STATS_FLUSH_MS;
  }

  /**
   * Proposes a rule. The daemon mints `id`, `created_at`, `stats` and — for
   * every principal — `status: 'proposed'`: §5.1's gap between a proposal
   * and a rule is "the only place the human's authority lives", so even a
   * `human` create goes in proposed and is accepted by a second, explicit
   * act (`accept`, which is what stamps `decided_*`).
   */
  async create(principal: RulePrincipal, rawInput: unknown): Promise<Rule> {
    const input: RuleProposal = validateRuleProposal(rawInput);
    const scope: RuleScope = input.scope ?? { kind: 'global' };
    this.assertScopeExists(scope);
    const record: RuleInput = {
      id: `R-${ulid()}`,
      text: input.text,
      ...(input.question !== undefined ? { question: input.question } : {}),
      scope,
      status: 'proposed',
      enforcement: input.enforcement ?? 'guidance',
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
      critical: input.critical ?? false,
      examples: input.examples ?? [],
      provenance: input.provenance ?? { by: principal === 'agent' ? 'agent' : principal },
      stats: {},
      created_at: this.clock().toISOString(),
    };
    return this.options.store.createRule(principal, record);
  }

  get(id: string): Rule {
    this.flushStatsSoon();
    return this.withPendingStats(this.options.store.getRule(id));
  }

  /** Every rule, oldest first, optionally filtered by status and/or scope. */
  list(options: ListRulesOptions = {}): Rule[] {
    this.flushStatsSoon();
    return this.readRules().filter((rule) => {
      if (options.status !== undefined && rule.status !== options.status) return false;
      if (options.scope !== undefined && formatRuleScope(rule.scope) !== options.scope) {
        return false;
      }
      return true;
    });
  }

  /** The inbox's `rule_accept` items (§3.1): every rule still awaiting a decision. */
  listProposed(): Rule[] {
    return this.list({ status: 'proposed' });
  }

  /**
   * §5.3's filter over this home's rules, for one stream: the service
   * resolves the stream and its ancestor chain, `rulesInScope` does the
   * filtering. This is what the brief and the hook call.
   */
  inScope(streamId: string, stage?: RuleStage): Rule[] {
    const stream = this.options.streams.get(streamId);
    return rulesInScope(this.options.store.listRules(), stream, this.ancestorsOf(stream), stage);
  }

  /** Root→leaf ancestor chain, excluding the stream itself. Cycles are impossible (the store rejects them). */
  ancestorsOf(stream: Stream): Stream[] {
    const chain: Stream[] = [];
    const seen = new Set<string>([stream.id]);
    let parent = stream.parent;
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent);
      const record = this.options.streams.get(parent);
      chain.unshift(record);
      parent = record.parent;
    }
    return chain;
  }

  /**
   * The human's accept (§3.1, **D4**): `status: accepted` plus `decided_at`
   * and `decided_by`, the three fields no agent may write. The store
   * re-checks the tier invariants, so accepting a classifier rule with one
   * example fails here rather than producing a gate that cannot be
   * evaluated (§5.6).
   */
  async accept(id: string, by: string): Promise<Rule> {
    return this.decide(id, 'accepted', by);
  }

  /** Retiring is a status change; nothing is deleted (§5.7). */
  async retire(id: string, by: string): Promise<Rule> {
    return this.decide(id, 'retired', by);
  }

  private async decide(id: string, status: RuleStatus, by: string): Promise<Rule> {
    const current = this.options.store.getRule(id);
    if (current.status === status) throw new RuleAlreadyDecidedError(id, status);
    const decided_at = this.clock().toISOString();
    return this.options.store.updateRule(
      'human',
      id,
      (before) => ({ ...before, status, decided_at, decided_by: by }),
      { kind: 'rule_decided' },
    );
  }

  /**
   * Edits a rule in place — §3.1's "edit-then-accept" half, and the only
   * way a rule's wording, tier or examples change. `status` and `decided_*`
   * are not patchable here: a decision goes through `accept`/`retire`, so
   * an edit can never smuggle one in.
   */
  async update(principal: RulePrincipal, id: string, patch: RulePatch): Promise<Rule> {
    if (patch.scope !== undefined) this.assertScopeExists(patch.scope);
    return this.options.store.updateRule(principal, id, (before) => ({ ...before, ...patch }));
  }

  /**
   * §5.7's pruning input, recorded by both enforcement tiers on every rule
   * they evaluate (T143). `fired` counts evaluations — that is what makes
   * "fired often, never violated" a signal that the rule is dead weight —
   * so every outcome bumps it, and `violated`/`routed` are the two
   * refinements on top: a pattern rule that denied, and a classifier rule
   * whose band routed the call to the human (T151).
   *
   * **Coalesced, not written through.** A gated tool call evaluates every
   * pattern rule in scope, so writing here would mean a YAML rewrite and a
   * `rule_put` event per rule per call. Counters accumulate in memory and
   * are flushed as one `updateRule` per rule at most every
   * `statsFlushMs` (5 s), on any read of the rules, and on daemon
   * shutdown. A read never sees a stale count: `get`/`list` merge whatever
   * is still pending into what they return (`withPendingStats`).
   *
   * What a crash costs: the counters since the last flush, which is the
   * right trade for telemetry — nothing a decision depends on is in here.
   *
   * Always written as `daemon`: stats are the daemon's own field, not a
   * decision, so no human is involved and no agent can forge one.
   */
  async recordFired(id: string, outcome: 'fired' | 'violated' | 'routed'): Promise<void> {
    const pending = this.pendingStats.get(id) ?? {
      fired: 0,
      violated: 0,
      routed: 0,
      last_fired_at: '',
    };
    pending.fired += 1;
    if (outcome === 'violated') pending.violated += 1;
    if (outcome === 'routed') pending.routed += 1;
    pending.last_fired_at = this.clock().toISOString();
    this.pendingStats.set(id, pending);
    this.armStatsTimer();
  }

  /** The record as a reader should see it: on disk plus whatever has not been flushed yet. */
  private withPendingStats(rule: Rule): Rule {
    const pending = this.pendingStats.get(rule.id);
    if (pending === undefined) return rule;
    return {
      ...rule,
      stats: {
        fired: rule.stats.fired + pending.fired,
        violated: rule.stats.violated + pending.violated,
        routed: rule.stats.routed + pending.routed,
        last_fired_at: pending.last_fired_at,
      },
    };
  }

  /** Every rule, with pending counters merged in. */
  private readRules(): Rule[] {
    return this.options.store.listRules().map((rule) => this.withPendingStats(rule));
  }

  private armStatsTimer(): void {
    if (this.statsTimer !== undefined || this.statsFlushMs <= 0) return;
    this.statsTimer = setInterval(() => {
      void this.flushStats();
    }, this.statsFlushMs);
    this.statsTimer.unref?.();
  }

  /** Fire-and-forget flush, for the sync read paths — a no-op when nothing is pending. */
  private flushStatsSoon(): void {
    if (this.pendingStats.size === 0) return;
    void this.flushStats();
  }

  /**
   * Writes every pending counter as one `updateRule` per rule. Awaited by
   * the daemon's shutdown path and by tests that want a deterministic
   * point; called on the timer and on reads otherwise. Serialized, so two
   * overlapping flushes never double-count.
   */
  flushStats(): Promise<void> {
    const next = this.flushing.then(() => this.doFlushStats());
    this.flushing = next.catch(() => undefined);
    return next;
  }

  private async doFlushStats(): Promise<void> {
    if (this.pendingStats.size === 0) return;
    const batch = [...this.pendingStats.entries()];
    this.pendingStats.clear();
    for (const [id, delta] of batch) {
      try {
        await this.options.store.updateRule('daemon', id, (before) => ({
          ...before,
          stats: {
            fired: before.stats.fired + delta.fired,
            violated: before.stats.violated + delta.violated,
            routed: before.stats.routed + delta.routed,
            last_fired_at: delta.last_fired_at,
          },
        }));
      } catch {
        // The rule is gone (or unwritable): drop its counters rather than
        // retry forever. Telemetry, not a decision.
      }
    }
  }

  /** Stops the flush timer. The daemon calls this after a final `flushStats()`. */
  dispose(): void {
    if (this.statsTimer !== undefined) {
      clearInterval(this.statsTimer);
      this.statsTimer = undefined;
    }
  }

  /** A `repo` ref must be in `repos.yaml`; a `stream` ref must be a stream in this home (§5.1). */
  private assertScopeExists(scope: RuleScope): void {
    if (scope.kind === 'global' || scope.ref === undefined) return;
    if (scope.kind === 'repo') {
      const repos = this.options.store.getRepos();
      if (repos[scope.ref] === undefined) {
        const known = Object.keys(repos).sort();
        throw new UnknownRuleScopeError(
          scope,
          known.length > 0
            ? `not registered in repos.yaml (registered: ${known.join(', ')})`
            : 'no repos are registered',
        );
      }
      return;
    }
    if (!this.options.store.hasStream(scope.ref)) {
      throw new UnknownRuleScopeError(scope, 'not a stream in this home');
    }
  }
}
