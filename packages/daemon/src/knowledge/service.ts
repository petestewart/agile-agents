/**
 * `KnowledgeService`: propose, read, list, accept, retire and edit
 * knowledge items (projects-design §5, §14.3), plus the one scope filter.
 * Every method takes an explicit principal (`human` from the RPC edge,
 * `agent` from `propose_knowledge`, `daemon` for built-ins and stats); the store
 * enforces the split.
 *
 * `knowledgeInScope` is the only scope filter, used by the brief, the hook
 * and the ship check, so an out-of-scope item can't reach any of them by a
 * caller forgetting to filter. Scopes stack (§5): global, the node's repo,
 * its project and its subtree, then `paths` narrows an item to the files
 * being edited (action) or changed (ship).
 */

import { isAbsolute, relative } from 'node:path';
import {
  type KnowledgeEnforcement,
  type KnowledgeItem,
  type KnowledgeItemInput,
  type KnowledgePatch,
  type KnowledgePrincipal,
  type KnowledgeProposal,
  type KnowledgeScope,
  type KnowledgeStatus,
  type Stream,
  formatKnowledgeScope,
  ulid,
  validateKnowledgeProposal,
} from '@agile-agents/shared';
import type { EmitRouted } from '../events/producers';
import type { StateStore } from '../store/store';
import type { StreamService } from '../streams/service';

/** An item whose scope names nothing in this home (-32602 at the edge). */
export class UnknownKnowledgeScopeError extends Error {
  constructor(
    public readonly scope: KnowledgeScope,
    detail: string,
  ) {
    super(`unknown knowledge scope: ${formatKnowledgeScope(scope)} — ${detail}`);
    this.name = 'UnknownKnowledgeScopeError';
  }
}

/** A decision on an item that is already in that state (accepting an accepted item). */
export class KnowledgeAlreadyDecidedError extends Error {
  constructor(id: string, status: KnowledgeStatus) {
    super(`knowledge item ${id} is already ${status}`);
    this.name = 'KnowledgeAlreadyDecidedError';
  }
}

export interface ListKnowledgeOptions {
  status?: KnowledgeStatus;
  /** `global` · `repo:<name>` · `project:<id>` · `subtree:<id>` — the rendered scope. */
  scope?: string;
}

export interface KnowledgeServiceOptions {
  store: StateStore;
  streams: StreamService;
  /** Test seam; real usage runs on the system clock. */
  clock?: () => Date;
  /**
   * How often coalesced `stats` are written. `0` disables the timer,
   * leaving flush-on-read and flush-on-shutdown (a deterministic test point).
   */
  statsFlushMs?: number;
  /** T264: `knowledge_accepted` goes to every live node in the item's scope. */
  emitRouted?: EmitRouted;
}

/**
 * The stats-flush interval. A gated call evaluates every pattern rule in
 * scope; a YAML rewrite and `knowledge_put` event per item per call would make
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
 * The one scope filter: accepted items that are global, scoped to the
 * stream's repo or project, or to the stream's subtree (the stream or any
 * ancestor). `proposed` and `retired` items are never in scope.
 * `enforcement` selects the checkpoint (`action` for the hook, `ship` for
 * delivery); omitted, every item is in scope (the brief tells them all).
 */
export function knowledgeInScope(
  items: readonly KnowledgeItem[],
  stream: Stream,
  ancestors: readonly Stream[] = [],
  enforcement?: KnowledgeEnforcement,
  paths?: readonly string[],
): KnowledgeItem[] {
  const streamIds = new Set<string>([stream.id, ...ancestors.map((a) => a.id)]);
  return items.filter((item) => {
    if (item.status !== 'accepted') return false;
    if (enforcement !== undefined && item.enforcement !== enforcement) return false;
    if (paths !== undefined && !knowledgeMatchesPaths(item, paths)) return false;
    switch (item.scope.kind) {
      case 'global':
        return true;
      case 'repo':
        return stream.repo === item.scope.repo;
      case 'project':
        return stream.project === item.scope.project;
      case 'subtree':
        return streamIds.has(item.scope.node);
    }
  });
}

/**
 * `paths` (T261): an item with no globs applies to every path; one with
 * globs applies only when a touched path (repo-relative) matches one. A
 * call or diff that names no path gets no path-limited item.
 */
export function knowledgeMatchesPaths(item: KnowledgeItem, paths: readonly string[]): boolean {
  const globs = item.paths ?? [];
  if (globs.length === 0) return true;
  return paths.some((path) => globs.some((glob) => new Bun.Glob(glob).match(path)));
}

/** Tool-call paths as repo-relative paths; a path outside the worktree is dropped. */
export function worktreeRelativePaths(paths: readonly string[], worktreePath: string): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const rel = isAbsolute(path) ? relative(worktreePath, path) : path.replace(/^\.\//, '');
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    out.push(rel);
  }
  return out;
}

export class KnowledgeService {
  private readonly clock: () => Date;
  private readonly statsFlushMs: number;
  /** Coalesced `stats` deltas, keyed by rule id — see `recordFired`. */
  private readonly pendingStats = new Map<string, PendingRuleStats>();
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  /** Serializes flushes so two of them never read the same `before` record. */
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly options: KnowledgeServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.statsFlushMs = options.statsFlushMs ?? DEFAULT_STATS_FLUSH_MS;
  }

  /**
   * Proposes an item. Every principal's create goes in `proposed`: nothing
   * applies until a human accepts it (§5), so acceptance is always a
   * second, explicit act. An `action`/`ship` item proposed without a check
   * gets an empty classifier check (it needs two examples to be accepted).
   */
  async create(principal: KnowledgePrincipal, rawInput: unknown): Promise<KnowledgeItem> {
    const input: KnowledgeProposal = validateKnowledgeProposal(rawInput);
    const scope: KnowledgeScope = input.scope ?? { kind: 'global' };
    this.assertScopeExists(scope);
    const enforcement = input.enforcement ?? 'tell';
    const check =
      input.check ??
      (enforcement === 'action' || enforcement === 'ship'
        ? { by: 'classifier' as const, examples: [] }
        : undefined);
    const record: KnowledgeItemInput = {
      id: `K-${ulid()}`,
      ...(input.name !== undefined ? { name: input.name } : {}),
      kind: input.kind ?? 'standard',
      text: input.text,
      scope,
      ...(input.paths !== undefined ? { paths: input.paths } : {}),
      enforcement,
      ...(check !== undefined ? { check } : {}),
      critical: input.critical ?? false,
      source: input.source ?? { by: principal === 'agent' ? 'agent' : 'human' },
      status: 'proposed',
      stats: {},
      created_at: this.clock().toISOString(),
    };
    return this.options.store.createKnowledge(principal, record);
  }

  get(id: string): KnowledgeItem {
    this.flushStatsSoon();
    return this.withPendingStats(this.options.store.getKnowledge(id));
  }

  /** Every rule, oldest first, optionally filtered by status and/or scope. */
  list(options: ListKnowledgeOptions = {}): KnowledgeItem[] {
    this.flushStatsSoon();
    return this.readRules().filter((rule) => {
      if (options.status !== undefined && rule.status !== options.status) return false;
      if (options.scope !== undefined && formatKnowledgeScope(rule.scope) !== options.scope) {
        return false;
      }
      return true;
    });
  }

  /** The inbox's `rule_accept` items (§3.1): every rule still awaiting a decision. */
  listProposed(): KnowledgeItem[] {
    return this.list({ status: 'proposed' });
  }

  /** §5.3's filter for one stream and its ancestors: what the brief and the hook call. */
  inScope(
    streamId: string,
    enforcement?: KnowledgeEnforcement,
    paths?: readonly string[],
  ): KnowledgeItem[] {
    const stream = this.options.streams.get(streamId);
    return knowledgeInScope(
      this.options.store.listKnowledge(),
      stream,
      this.ancestorsOf(stream),
      enforcement,
      paths,
    );
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
  async accept(id: string, by: string): Promise<KnowledgeItem> {
    const item = await this.decide(id, 'accepted', by);
    if (this.options.emitRouted !== undefined) {
      const parties = this.liveNodesInScope(item);
      if (parties.length > 0) {
        await this.options.emitRouted({
          type: 'knowledge_accepted',
          payload: {
            item: item.id,
            kind: item.kind,
            text: item.text.slice(0, 200),
            enforcement: item.enforcement,
          },
          ref: `knowledge/${item.id}.yaml`,
          by: 'human',
          parties,
        });
      }
    }
    return item;
  }

  /** Live (not archived, closed or landed) nodes the item applies to. */
  liveNodesInScope(item: KnowledgeItem): string[] {
    return this.options.streams
      .list()
      .filter(
        (s) =>
          s.archived !== true &&
          s.human.status !== 'closed' &&
          s.human.status !== 'landed' &&
          knowledgeInScope([item], s, this.ancestorsOf(s)).length > 0,
      )
      .map((s) => s.id);
  }

  /** Retiring is a status change; nothing is deleted (§5.7). */
  async retire(id: string, by: string): Promise<KnowledgeItem> {
    return this.decide(id, 'retired', by);
  }

  private async decide(id: string, status: KnowledgeStatus, by: string): Promise<KnowledgeItem> {
    const current = this.options.store.getKnowledge(id);
    if (current.status === status) throw new KnowledgeAlreadyDecidedError(id, status);
    const decided_at = this.clock().toISOString();
    return this.options.store.updateKnowledge(
      'human',
      id,
      (before) => ({ ...before, status, decided_at, decided_by: by }),
      { kind: 'knowledge_decided' },
    );
  }

  /** Edits wording, tier or examples in place. Decisions go through `accept`/`retire`, never an edit. */
  async update(
    principal: KnowledgePrincipal,
    id: string,
    patch: KnowledgePatch,
  ): Promise<KnowledgeItem> {
    if (patch.scope !== undefined) this.assertScopeExists(patch.scope);
    return this.options.store.updateKnowledge(principal, id, (before) =>
      withCheckFor({ ...before, ...patch }, patch.check !== undefined),
    );
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
  private withPendingStats(rule: KnowledgeItem): KnowledgeItem {
    const pending = this.pendingStats.get(rule.id);
    if (pending === undefined) return rule;
    return { ...rule, stats: addStats(rule.stats, pending) };
  }

  /** Every rule, with pending counters merged in. */
  private readRules(): KnowledgeItem[] {
    return this.options.store.listKnowledge().map((rule) => this.withPendingStats(rule));
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
        await this.options.store.updateKnowledge('daemon', id, (before) => ({
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

  /** A repo must be in `repos.yaml`, a project and a subtree node must exist in this home. */
  private assertScopeExists(scope: KnowledgeScope): void {
    if (scope.kind === 'global') return;
    if (scope.kind === 'repo') {
      const repos = this.options.store.getRepos();
      if (repos[scope.repo] === undefined) {
        const known = Object.keys(repos).sort();
        throw new UnknownKnowledgeScopeError(
          scope,
          known.length > 0
            ? `not registered in repos.yaml (registered: ${known.join(', ')})`
            : 'no repos are registered',
        );
      }
      return;
    }
    if (scope.kind === 'project') {
      if (!this.options.store.listProjects().some((p) => p.id === scope.project)) {
        throw new UnknownKnowledgeScopeError(scope, 'not a project in this home');
      }
      return;
    }
    if (!this.options.store.hasStream(scope.node)) {
      throw new UnknownKnowledgeScopeError(scope, 'not a stream in this home');
    }
  }
}

/**
 * An edit that moves an item to `tell`/`review` drops its check (a patch
 * cannot clear a field), and one that moves it to `action`/`ship` with no
 * check gets the empty classifier check `create` would have given it.
 */
function withCheckFor(item: KnowledgeItem, patched: boolean): KnowledgeItem {
  const checked = item.enforcement === 'action' || item.enforcement === 'ship';
  if (!checked && item.check !== undefined && !patched) {
    const { check: _dropped, ...rest } = item;
    return rest;
  }
  if (checked && item.check === undefined) {
    return { ...item, check: { by: 'classifier', examples: [] } };
  }
  return item;
}

function addStats(stats: KnowledgeItem['stats'], delta: PendingRuleStats): KnowledgeItem['stats'] {
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
