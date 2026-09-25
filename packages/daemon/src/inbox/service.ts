/**
 * `InboxService`: everything waiting on the human, across every stream,
 * oldest first (§3), derived on every call from existing records: open
 * questions, pending gates, proposed rules (seed imports grouped into one
 * `rule_batch` per source), and streams whose agent is `blocked`/`done`
 * while the human half is still `open`. Nothing is persisted and nothing
 * comes from the bus, so a stale message can never surface (§3.3).
 */

import {
  type HilRequest,
  type InboxItem,
  type KnowledgeItem,
  type Question,
  type Stream,
  describeGateCall,
  formatKnowledgeScope,
  inboxContext,
  inboxDetail,
  liveChildrenOf,
} from '@agile-agents/shared';
import type { AutonomyService } from '../coordination/autonomy';
import type { ContractService } from '../coordination/contracts';
import type { PlanService } from '../coordination/plans';
import type { GateService } from '../gates/service';
import type { KnowledgeService } from '../knowledge/service';
import type { QuestionService } from '../questions/service';
import type { StreamService } from '../streams/service';

/** The full text behind a clipped context, as a spreadable field. */
function withDetail(text: string): { detail?: string } {
  const detail = inboxDetail(text);
  return detail === undefined ? {} : { detail };
}

function gateText(gate: HilRequest): string {
  return `${gate.gate}: ${gate.call !== undefined ? `${describeGateCall(gate.call)} — ` : ''}${
    gate.summary ?? gate.reason ?? 'needs your decision'
  }`;
}

export interface InboxServiceDeps {
  streams: StreamService;
  questions: QuestionService;
  gates: GateService;
  /** A proposed rule is a `rule_accept` item (§3.1). */
  rules?: KnowledgeService;
  /** T281: a draft plan is a `plan_approve` item (§9.1: approval at every level). */
  plans?: Pick<PlanService, 'listDraft'>;
  contracts?: Pick<ContractService, 'find'>;
  /** T282: a coordinator's change held at Advise is a `proposal` item with Apply. */
  proposals?: Pick<AutonomyService, 'listOpen'>;
}

export class InboxService {
  constructor(private readonly deps: InboxServiceDeps) {}

  /** Every open item, oldest first (§3.3). A record whose stream is gone is skipped: an item you can't place is worse than none. */
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
    // Proposed knowledge (§3.1, projects-design §5); a `rule_accept` item
    // may name no stream (a global item). Proposals the home migration
    // carried over from a seed import collapse into one card; lessons and
    // agent proposals stay one card each.
    const seeded = new Map<string, KnowledgeItem[]>();
    for (const rule of this.deps.rules?.listProposed() ?? []) {
      if (rule.source.by === 'migration') {
        const batch = seeded.get(rule.source.by) ?? [];
        batch.push(rule);
        seeded.set(rule.source.by, batch);
      } else {
        items.push(this.ruleItem(rule, byId));
      }
    }
    for (const [source, rules] of seeded) items.push(this.ruleBatchItem(source, rules));
    for (const plan of this.deps.plans?.listDraft() ?? []) {
      const stream = byId.get(plan.node);
      if (stream === undefined || stream.archived === true) continue;
      const titleOf = (id: string) => byId.get(id)?.title ?? id;
      // A revision reads as its change against the last approved version.
      const was = new Map(plan.approved?.owners.map((o) => [o.child, o.owns.join(', ')]) ?? []);
      const owners = plan.owners.map((o) => {
        const now = o.owns.length === 0 ? 'nothing' : o.owns.join(', ');
        const before = was.get(o.child);
        const change =
          plan.approved === undefined || before === o.owns.join(', ')
            ? ''
            : ` (was ${before === undefined ? 'not in the plan' : before || 'nothing'})`;
        return `${titleOf(o.child)} owns ${now}${change}`;
      });
      const contracts = plan.contracts.map((id) => {
        const c = this.deps.contracts?.find(id);
        return c === undefined ? id : `${c.title}: ${c.body}`;
      });
      const text = `Approve ${plan.approved === undefined ? 'the plan' : `the revised plan (approved v${plan.approved.version})`} for ${stream.title}: ${owners.join('; ') || 'no owners'}${
        contracts.length > 0 ? `. Contracts: ${contracts.join(' | ')}` : ''
      }`;
      items.push({
        kind: 'plan_approve',
        id: stream.id,
        stream: stream.id,
        stream_path: this.path(stream, byId),
        ts: plan.updated_at,
        context: inboxContext(text),
        ...withDetail(text),
        ref: `plans/${stream.id}.yaml`,
      });
    }
    for (const proposal of this.deps.proposals?.listOpen() ?? []) {
      const stream = byId.get(proposal.node);
      if (stream === undefined || stream.archived === true) continue;
      const text = `${proposal.principal} proposes: ${proposal.summary}`;
      items.push({
        kind: 'proposal',
        id: proposal.id,
        stream: stream.id,
        stream_path: this.path(stream, byId),
        ts: proposal.created_at,
        context: inboxContext(text),
        ...withDetail(text),
        ref: `proposals/${proposal.id}.yaml`,
      });
    }
    for (const stream of byId.values()) {
      const item = this.streamItem(stream, byId);
      if (item) items.push(item);
    }

    return items.sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts < b.ts ? -1 : 1));
  }

  /** Ancestor titles, root→leaf (§3.2); the seen-set keeps it total. */
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
      ...withDetail(question.text),
      ref: `questions/${question.id}.yaml`,
    };
  }

  private ruleItem(rule: KnowledgeItem, byId: Map<string, Stream>): InboxItem {
    const stream = rule.source.node === undefined ? undefined : byId.get(rule.source.node);
    const label = `${rule.name !== undefined ? `${rule.name} · ` : ''}${formatKnowledgeScope(rule.scope)}: ${rule.text}`;
    return {
      kind: 'rule_accept',
      id: rule.id,
      ...(stream ? { stream: stream.id } : {}),
      stream_path: stream ? this.path(stream, byId) : [],
      ts: rule.created_at,
      context: inboxContext(label),
      ...withDetail(label),
      ref: `knowledge/${rule.id}.yaml`,
      knowledge_kind: rule.kind,
    };
  }

  /** One card for a seed source's open proposals, sorted where its first rule would be. */
  private ruleBatchItem(source: string, rules: KnowledgeItem[]): InboxItem {
    const sorted = [...rules].sort((a, b) =>
      a.created_at === b.created_at
        ? a.id.localeCompare(b.id)
        : a.created_at < b.created_at
          ? -1
          : 1,
    );
    const first = sorted[0] as KnowledgeItem;
    const noun = sorted.length === 1 ? 'proposed rule' : 'proposed rules';
    return {
      kind: 'rule_batch',
      id: source,
      stream_path: [],
      ts: first.created_at,
      context: inboxContext(`${sorted.length} ${noun} from ${source}`),
      rules: sorted.map((rule) => rule.id),
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
      // A routed call is decided on the call itself, so the card leads with it (§3.2).
      context: inboxContext(gateText(gate)),
      ...withDetail(gateText(gate)),
      ref: `gates/${gate.id}.yaml`,
    };
  }

  /**
   * §2.2's disagreeing pair: the agent stopped (`blocked` or `done`) and the
   * human half is still `open`. That pair is the "waiting for me" state.
   */
  private streamItem(stream: Stream, byId: Map<string, Stream>): InboxItem | undefined {
    if (stream.archived === true) return undefined;
    if (stream.human.status !== 'open') return undefined;
    if (stream.agent.status !== 'blocked' && stream.agent.status !== 'done') return undefined;
    // T336: a coordinating node or a project root has no branch of its own;
    // its coordinator finishing a turn is nothing to land.
    if (stream.agent.status === 'done' && (hasParts(stream.id, byId) || isProjectRoot(stream))) {
      return undefined;
    }
    return {
      kind: stream.agent.status,
      id: stream.id,
      stream: stream.id,
      stream_path: this.path(stream, byId),
      ts: stream.agent.updated_at,
      context: inboxContext(
        stream.agent.progress ??
          (stream.agent.status === 'done'
            ? // Name both exits, so a stream you won't land has a way out.
              'worker finished — land or close the stream'
            : 'blocked'),
      ),
      ...(stream.agent.progress !== undefined ? withDetail(stream.agent.progress) : {}),
    };
  }
}

/** Live children other than helpers: what makes a node coordinating (`nodeRole`). */
function hasParts(id: string, byId: Map<string, Stream>): boolean {
  return liveChildrenOf(id, [...byId.values()]).some((c) => c.helper_of !== id);
}

/** A project's root node (P20: its agent is the project's coordinator). */
function isProjectRoot(stream: Stream): boolean {
  return stream.parent === undefined && stream.project !== undefined;
}
