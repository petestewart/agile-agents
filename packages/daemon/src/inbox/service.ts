/**
 * `InboxService` — one list of everything waiting on the human, across
 * every stream, oldest first (design/cockpit-design.md §3).
 *
 * The list is **derived on every call** from records that already exist:
 *  - `questions/Q-*.yaml` with `status: open`          → `question`
 *  - `gates/HIL-*.yaml` with `status: pending`     → `gate`
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
  type Stream,
  inboxContext,
} from '@agile-agents/shared';
import type { GateService } from '../gates/service';
import type { QuestionService } from '../questions/service';
import type { StreamService } from '../streams/service';

export interface InboxServiceDeps {
  streams: StreamService;
  questions: QuestionService;
  gates: GateService;
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

  private gateItem(gate: HilRequest, byId: Map<string, Stream>): InboxItem | undefined {
    const stream = byId.get(gate.stream);
    if (!stream) return undefined;
    return {
      kind: 'gate',
      id: gate.id,
      stream: stream.id,
      stream_path: this.path(stream, byId),
      ts: gate.requested_at,
      context: inboxContext(
        `${gate.gate}: ${gate.summary ?? gate.reason ?? 'needs your decision'}`,
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
          (stream.agent.status === 'done' ? 'worker finished — review and land' : 'blocked'),
      ),
    };
  }
}
