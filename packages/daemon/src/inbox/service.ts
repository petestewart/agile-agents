/**
 * `InboxService` — one list of everything waiting on the human, across
 * every stream, oldest first (design/cockpit-design.md §3).
 *
 * The list is **derived on every call** from records that already exist:
 *  - `questions/Q-*.yaml` with `status: open`          → `question`
 *  - `gates/HIL-*.yaml` with `status: pending`     → `gate`
 *  - `rules/R-*.yaml` with `status: proposed`            → `rule_accept`
 *  - streams whose `agent.status` is `blocked`/`done`
 *    while `human.status` is still `open`              → `blocked` / `done`
 *
 * Nothing is persisted and nothing is read from the bus, which is what
 * makes §3.3's "items are records, not messages" true: a daemon restart
 * re-reads them, and a leftover bus message from a previous run cannot
 * appear here at all. This is the fix for the 2026-09-11 live run's stale
 * questions (§1.4).
 */

import {
  type HilRequest,
  type InboxItem,
  type Question,
  type Rule,
  type Stream,
  describeGateCall,
  formatRuleScope,
  inboxContext,
} from '@agile-agents/shared';
import type { GateService } from '../gates/service';
import type { QuestionService } from '../questions/service';
import type { RulesService } from '../rules/service';
import type { StreamService } from '../streams/service';

export interface InboxServiceDeps {
  streams: StreamService;
  questions: QuestionService;
  gates: GateService;
  /** T140's rules — a proposed rule is a `rule_accept` item (§3.1). */
  rules?: RulesService;
}

export class InboxService {
  constructor(private readonly deps: InboxServiceDeps) {}

  /**
   * Every open item, oldest first (§3.3: "the operator's attention is one
   * queue whatever the tree looks like"). A record whose stream has been
   * deleted is skipped rather than shown with no path — an item you cannot
   * place is worse than no item.
   */
  list(): InboxItem[] {
    const byId = new Map<string, Stream>(
      this.deps.streams.list({ include_archived: true }).map((s) => [s.id, s]),
    );
    const items: InboxItem[] = [];

    for (const question of this.deps.questions.listOpen()) {
      const item = this.questionItem(question, byId);
      if (item) items.push(item);
    }
    for (const gate of this.deps.gates.list()) {
      if (gate.status !== 'pending') continue;
      const item = this.gateItem(gate, byId);
      if (item) items.push(item);
    }
    // T140: every rule still awaiting the human's decision (§3.1,
    // §5.1). Unlike every other item, a `rule_accept` item may name no
    // stream: a global rule proposed by the human, or one imported by
    // `agile rules seed`, belongs to no stream and still needs deciding.
    for (const rule of this.deps.rules?.listProposed() ?? []) {
      items.push(this.ruleItem(rule, byId));
    }
    for (const stream of byId.values()) {
      const item = this.streamItem(stream, byId);
      if (item) items.push(item);
    }

    return items.sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts < b.ts ? -1 : 1));
  }

  /** Ancestor chain as titles, root→leaf (§3.2). Cycles are impossible (the store rejects them) but the seen-set keeps this total anyway. */
  private path(stream: Stream, byId: Map<string, Stream>): string[] {
    const titles: string[] = [];
    const seen = new Set<string>();
    let current: Stream | undefined = stream;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      titles.unshift(current.title);
      current = current.parent === undefined ? undefined : byId.get(current.parent);
    }
    return titles;
  }

  private questionItem(question: Question, byId: Map<string, Stream>): InboxItem | undefined {
    const stream = byId.get(question.stream);
    if (!stream) return undefined;
    return {
      kind: 'question',
      id: question.id,
      stream: stream.id,
      stream_path: this.path(stream, byId),
      ts: question.raised_at,
      context: inboxContext(question.text),
      ref: `questions/${question.id}.yaml`,
    };
  }

  private ruleItem(rule: Rule, byId: Map<string, Stream>): InboxItem {
    const stream =
      rule.provenance.stream === undefined ? undefined : byId.get(rule.provenance.stream);
    return {
      kind: 'rule_accept',
      id: rule.id,
      ...(stream ? { stream: stream.id } : {}),
      stream_path: stream ? this.path(stream, byId) : [],
      ts: rule.created_at,
      context: inboxContext(`${formatRuleScope(rule.scope)}: ${rule.text}`),
      ref: `rules/${rule.id}.yaml`,
    };
  }

  private gateItem(gate: HilRequest, byId: Map<string, Stream>): InboxItem | undefined {
    const stream = byId.get(gate.stream);
    if (!stream) return undefined;
    return {
      kind: 'gate',
      id: gate.id,
      stream: stream.id,
      stream_path: this.path(stream, byId),
      ts: gate.requested_at,
      // T138: a routed tool call is decided on the call itself, so the card
      // leads with it ("edit /…/package.json — editing a dependency
      // manifest…") rather than making the operator open the record (§3.2:
      // "enough to decide in ten seconds without leaving the list").
      context: inboxContext(
        `${gate.gate}: ${gate.call !== undefined ? `${describeGateCall(gate.call)} — ` : ''}${
          gate.summary ?? gate.reason ?? 'needs your decision'
        }`,
      ),
      ref: `gates/${gate.id}.yaml`,
    };
  }

  /**
   * §2.2's "allowed to disagree" pair: the agent has stopped (`blocked` at
   * a routed tool call, or `done` with its turn finished) and the human
   * half is still `open`, i.e. nobody has decided anything yet. That pair
   * — and only that pair — is the "waiting for me to look" state the tree
   * dot is coloured from, so it is an inbox item.
   */
  private streamItem(stream: Stream, byId: Map<string, Stream>): InboxItem | undefined {
    if (stream.archived === true) return undefined;
    if (stream.human.status !== 'open') return undefined;
    if (stream.agent.status !== 'blocked' && stream.agent.status !== 'done') return undefined;
    return {
      kind: stream.agent.status,
      id: stream.id,
      stream: stream.id,
      stream_path: this.path(stream, byId),
      ts: stream.agent.updated_at,
      context: inboxContext(
        stream.agent.progress ??
          (stream.agent.status === 'done'
            ? // T136 (QA rough edge 7): say what clears the item. "review and
              // land" named only one of the two exits, so a stream you decide
              // not to land looked like it had no way out of the inbox.
              'worker finished — land or close the stream'
            : 'blocked'),
      ),
    };
  }
}
