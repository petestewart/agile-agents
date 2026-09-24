/**
 * `RulesService`: propose, read, list, accept, retire and edit rules, plus
 * the one scope filter (§5). Every method takes an explicit principal
 * (`human` from the RPC edge, `agent` from `propose_rule`, `daemon` for
 * built-ins and stats); the store enforces the split.
 *
 * `rulesInScope` (§5.3) is the only scope filter, used by the brief and
 * the hook, so an out-of-scope rule can't reach either by a caller
 * forgetting to filter.
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

/** A rule whose `scope.ref` names nothing in this home (-32602 at the edge). */
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
   * How often coalesced `stats` are written. `0` disables the timer,
   * leaving flush-on-read and flush-on-shutdown (a deterministic test point).
   */
  statsFlushMs?: number;
}

/**
 * The stats-flush interval. A gated call evaluates every pattern rule in
 * scope; a YAML rewrite and `rule_put` event per rule per call would make
 * the log mostly bookkeeping. `hook_decision` stays per call.
 */
export const DEFAULT_STATS_FLUSH_MS = 5_000;

/**
 * What one `recordFired` call says happened (§5.7). `fired`, `violated`
 * and `routed` are firings; `resolved_violation` is the human's later deny
 * on a call already counted as `routed`, recorded without counting the
 * action twice.
 */
export type RuleStatsOutcome = 'fired' | 'violated' | 'routed' | 'resolved_violation';

/** Counters accumulated since the last flush, for one rule. */
interface PendingRuleStats {
  fired: number;
  violated: number;
  routed: number;
  last_fired_at: string;
}

/**
 * §5.3's one scope filter: accepted rules that are global, scoped to the
 * stream's repo, or scoped to the stream or any ancestor. `proposed` and
 * `retired` rules are never in scope. `stage` selects `'action'` (hook,
 * §8.1) or `'diff'` (landing, §8.2) rules, `'both'` matching either;
 * omitted, every stage is in scope (the brief injects all guidance).
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
   * Proposes a rule. Every principal's create goes in `proposed`: the gap
   * between a proposal and a rule is where the human's authority lives
   * (§5.1), so acceptance is always a second, explicit act.
   */
  async create(principal: RulePrincipal, rawInput: unknown): Promise<Rule> {
    const input: RuleProposal = validateRuleProposal(rawInput);
    const scope: RuleScope = input.scope ?? { kind: 'global' };
    this.assertScopeExists(scope);
    const record: RuleInput = {
      id: `R-${ulid()}`,
      text: input.text,
      ...(input.question !== undefined ? { question: input.question } : {}),
      ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
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

  /** §5.3's filter for one stream and its ancestors: what the brief and the hook call. */
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
   * The human's accept (D4): `status`, `decided_at`, `decided_by`, the
   * fields no agent may write. The store re-checks the tier invariants
   * (a classifier rule with one example can't be accepted, §5.6).
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

  /** Edits wording, tier or examples in place. Decisions go through `accept`/`retire`, never an edit. */
  async update(principal: RulePrincipal, id: string, patch: RulePatch): Promise<Rule> {
    if (patch.scope !== undefined) this.assertScopeExists(patch.scope);
    return this.options.store.updateRule(principal, id, (before) => ({ ...before, ...patch }));
  }

  /**
   * §5.7's pruning input, from both enforcement tiers. Every firing bumps
   * `fired` ("fired often, never violated" marks dead weight), with
   * `violated`/`routed` on top. `resolved_violation` bumps only `violated`:
   * counting the human's later deny as a second firing would skew the
   * report, which divides by `fired`.
   *
   * Coalesced: counters accumulate in memory and are flushed as one
   * `updateRule` per rule at most every `statsFlushMs`, on reads, and at
   * shutdown; reads merge pending counts in. A crash loses only the counts
   * since the last flush (telemetry). Always written as `daemon`.
   */
  async recordFired(id: string, outcome: RuleStatsOutcome): Promise<void> {
    const pending = this.pendingStats.get(id) ?? {
      fired: 0,
      violated: 0,
      routed: 0,
      last_fired_at: '',
    };
    if (outcome === 'resolved_violation') {
      pending.violated += 1;
    } else {
      pending.fired += 1;
      if (outcome === 'violated') pending.violated += 1;
      if (outcome === 'routed') pending.routed += 1;
      pending.last_fired_at = this.clock().toISOString();
    }
    this.pendingStats.set(id, pending);
    this.armStatsTimer();
  }

  /** The record as a reader should see it: on disk plus whatever is unflushed. */
  private withPendingStats(rule: Rule): Rule {
    const pending = this.pendingStats.get(rule.id);
    if (pending === undefined) return rule;
    return { ...rule, stats: addStats(rule.stats, pending) };
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

  /** Fire-and-forget flush for the sync read paths. */
  private flushStatsSoon(): void {
    if (this.pendingStats.size === 0) return;
    void this.flushStats();
  }

  /** Writes every pending counter, one `updateRule` per rule. Serialized, so flushes never double-count. */
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
          stats: addStats(before.stats, delta),
        }));
      } catch {
        // The rule is gone or unwritable: drop its counters (telemetry).
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

function addStats(stats: Rule['stats'], delta: PendingRuleStats): Rule['stats'] {
  return {
    fired: stats.fired + delta.fired,
    violated: stats.violated + delta.violated,
    routed: stats.routed + delta.routed,
    ...(delta.last_fired_at !== ''
      ? { last_fired_at: delta.last_fired_at }
      : stats.last_fired_at !== undefined
        ? { last_fired_at: stats.last_fired_at }
        : {}),
  };
}
