/**
 * T454 (D44 follow-up): with `knowledge_wake: jev` in the home config, Jev
 * decides whether an accepted knowledge item wakes a conversation that did
 * not propose it. Under the default (`source`) nothing here runs: only the
 * item's own conversation wakes (T453, `wake.ts`).
 *
 * The wake path never waits on it. When a conversation's wake verdict says
 * "no trigger" and it has a pending `knowledge_accepted` from elsewhere,
 * `consider` starts one classifier call per (event, node) and returns.
 * When Jev is sure the decision is relevant and sure the conversation is not
 * stale, the pair is approved and delivery looks at the node again; this
 * time `wakeVerdict` counts the event (at most `JEV_WAKES_PER_ITEM` per item).
 * Anything else (a no, an unsure answer, no key, an error, a timeout)
 * leaves the item pending: the conversation reads it with its next message,
 * as under `source`.
 *
 * The asked and approved pairs live in memory, like the wake budget: after
 * a restart a still-pending item may be asked about once more.
 */

import {
  type ClassifierBands,
  type ClassifierConfig,
  type KnowledgeItem,
  type RepoEntry,
  type RoutedEvent,
  type Stream,
  liveChildrenOf,
  nodeRole,
} from '@agile-agents/shared';
import { bandFor } from '../classifier/bands';
import { classifierEnabled } from '../classifier/enabled';
import {
  type Answer,
  type Classifier,
  ClassifierUnavailableError,
  type Noul,
} from '../classifier/types';
import { readHomeConfigFile } from '../config';
import type { StateStore } from '../store';

/** At most this many conversations woken by Jev per accepted item (cost stays bounded). */
export const JEV_WAKES_PER_ITEM = 5;
/** The conversation's last reply, its question and the item's text, capped in the state. */
export const LAST_REPLY_MAX_CHARS = 600;
export const QUESTION_MAX_CHARS = 400;
export const ITEM_TEXT_MAX_CHARS = 800;
const TITLE_MAX_CHARS = 120;
/** Newer conversations in the same project listed in the state, newest first. */
export const NEWER_CONVERSATIONS_MAX = 10;

/** (a): does the decision bear on what this conversation said or left open? */
export const RELEVANT_NOUL: Noul = {
  id: 'relevant',
  question:
    'Does this decision change the answer the conversation gave, or settle something the conversation left open?',
  criteria: {
    true: 'The decision contradicts, corrects or extends the last reply, or answers a question the conversation raised and did not resolve.',
    false:
      'The decision is about something else, or only restates what the conversation already concluded.',
  },
};

/**
 * (b): is the conversation still current? Asked the other way round, "is it
 * stale?", because against real Jev that framing separated the cases (an
 * open, recent conversation ~0.25-0.3; one a newer conversation covers
 * ~0.8) where "is it current?" left the open one unsure (~0.65). Current
 * is a confident no.
 */
export const STALE_NOUL: Noul = {
  id: 'stale',
  question:
    'Is this conversation stale: moved on from, covered by a newer conversation listed, too old to matter, or treated as finished?',
  criteria: {
    true: 'A newer conversation listed covers the same question, or the conversation is weeks old and was left behind, or its question was settled and closed.',
    false:
      'The conversation is recent and its question is still open; no newer conversation listed covers it.',
  },
};

export interface KnowledgeWakeJudgeOptions {
  store: StateStore;
  /** The live (not archived) nodes: for newer conversations and a subtree's title. */
  streams: () => Stream[];
  /** The home, whose `config.yaml` holds the switch (read on each call: live at once). */
  home: string;
  classifier: Classifier;
  /** `classifier:` from config.yaml (bands, provider, key); mutated in place by Settings. */
  config: ClassifierConfig;
  /** Key lookup for `classifierEnabled`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** The daemon log (never the conversation's text, never the key). */
  log?: (line: string) => void;
}

/**
 * §6.3's bands on a raw Noul value (D14: answer and certainty in one). The
 * hook's "deny" band is a confident yes and its "allow" band a confident
 * no; the route band between them is unsure, which wakes nobody.
 */
function confident(
  answer: Answer | undefined,
  bands: ClassifierBands,
  want: 'yes' | 'no',
): boolean {
  return answer !== undefined && bandFor(answer, bands) === (want === 'yes' ? 'deny' : 'allow');
}

const key = (event: string, node: string): string => `${event}:${node}`;

/** "5 minutes ago", "3 hours ago", "12 days ago". */
export function ageInWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const HUMAN_STATUS_WORDS: Record<Stream['human']['status'], string> = {
  open: 'open',
  waiting_on_you: 'waiting on the operator',
  landed: 'merged',
  closed: 'closed',
};

export class KnowledgeWakeJudge {
  /** (event, node) pairs already asked about (or being asked about). */
  private readonly asked = new Set<string>();
  /** (event, node) pairs Jev said yes to. */
  private readonly approved = new Set<string>();
  /** Yeses per knowledge item, for `JEV_WAKES_PER_ITEM`. */
  private readonly yeses = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: KnowledgeWakeJudgeOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.error(line));
  }

  /** The switch, read live; an unreadable config is the default. */
  on(): boolean {
    try {
      return readHomeConfigFile(this.options.home).knowledge_wake === 'jev';
    } catch {
      return false;
    }
  }

  /** `wakeVerdict`'s question: did Jev say this conversation should hear this event? */
  approvedFor(node: string, event: { id?: string }): boolean {
    // Switched off since the yes: back to `source`.
    return event.id !== undefined && this.approved.has(key(event.id, node)) && this.on();
  }

  /**
   * A conversation with no live session whose pending events woke nothing:
   * asks Jev about each accepted item it did not propose, once per
   * (event, node), and returns at once. `recheck` runs after a yes.
   */
  consider(node: Stream, pending: readonly RoutedEvent[], recheck: () => void): void {
    if (!this.on()) return;
    for (const event of pending) {
      if (event.type !== 'knowledge_accepted') continue;
      if (event.payload.source === node.id) continue;
      const k = key(event.id, node.id);
      if (this.asked.has(k)) continue;
      this.asked.add(k);
      void this.judge(node, event)
        .then((yes) => {
          if (yes) recheck();
        })
        .catch((err) =>
          this.log(
            `knowledge wake: ${event.id} for ${node.id} not judged: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
  }

  private async judge(node: Stream, event: RoutedEvent): Promise<boolean> {
    // Nothing of this (not even reading the thread) runs inside the caller's wake.
    await Promise.resolve();
    const item = String(event.payload.item);
    const tag = `knowledge wake: ${item} (${event.id}) for ${node.id}`;
    if ((this.yeses.get(item) ?? 0) >= JEV_WAKES_PER_ITEM) {
      this.log(`${tag}: not asked, ${JEV_WAKES_PER_ITEM} conversations already woken`);
      return false;
    }
    if (!this.enabledFor(node)) {
      this.log(`${tag}: not asked, the classifier is off or has no key`);
      return false;
    }
    let answers: Answer[];
    try {
      answers = await this.options.classifier.ask(this.stateFor(node, event), [
        RELEVANT_NOUL,
        STALE_NOUL,
      ]);
    } catch (err) {
      // The reason only: a message could carry more than this log should.
      const reason = err instanceof ClassifierUnavailableError ? err.reason : 'error';
      this.log(`${tag}: classifier unavailable (${reason}); it waits for its next message`);
      return false;
    }
    const bands = this.options.config.bands;
    const byId = new Map(answers.map((a) => [a.id, a]));
    const relevant = byId.get(RELEVANT_NOUL.id);
    const stale = byId.get(STALE_NOUL.id);
    const values = `relevant ${relevant?.probability ?? 'none'}, stale ${stale?.probability ?? 'none'}`;
    // Relevant: a confident yes. Still current: a confident no to "stale".
    if (!confident(relevant, bands, 'yes') || !confident(stale, bands, 'no')) {
      this.log(`${tag}: not woken (${values})`);
      return false;
    }
    // Counted at the yes, so answers landing together can't pass the cap.
    const count = this.yeses.get(item) ?? 0;
    if (count >= JEV_WAKES_PER_ITEM) {
      this.log(`${tag}: yes (${values}) but ${JEV_WAKES_PER_ITEM} already woken`);
      return false;
    }
    this.yeses.set(item, count + 1);
    this.approved.add(key(event.id, node.id));
    this.log(`${tag}: waking (${values})`);
    return true;
  }

  /** §6.4's opt-outs: the conversation's own, its repo's, then the home's provider and key. */
  private enabledFor(node: Stream): boolean {
    let repo: RepoEntry | undefined;
    if (node.repo !== undefined) {
      try {
        repo = this.options.store.getRepos()[node.repo];
      } catch {
        return false;
      }
    }
    return classifierEnabled({
      stream: node,
      repo,
      config: this.options.config,
      ...(this.options.env !== undefined ? { env: this.options.env } : {}),
    });
  }

  /** The state Jev reads: the item, the conversation, and the newer ones next to it. */
  stateFor(node: Stream, event: RoutedEvent): string {
    const { store } = this.options;
    const now = this.now();
    const p = event.payload as Record<string, unknown>;
    let item: KnowledgeItem | undefined;
    try {
      item = store.getKnowledge(String(p.item));
    } catch {
      item = undefined;
    }
    const thread = store.readThread(node.id);
    const said = thread.filter(
      (e) => e.kind === 'line' && (e.by === 'human' || e.by.startsWith('agent:')),
    );
    const lastReply = [...said].reverse().find((e) => e.by.startsWith('agent:'));
    const changedAt = Date.parse(said.at(-1)?.ts ?? node.created_at);
    const at = (iso: string) => (Number.isNaN(Date.parse(iso)) ? 0 : Date.parse(iso));

    const lines = [
      'An operator just accepted this decision for their project:',
      `- kind: ${String(p.kind)}; enforcement: ${String(p.enforcement)}; applies to ${item ? this.scopeInWords(item) : 'its scope'}`,
      `- text: ${clip(item?.text ?? String(p.text), ITEM_TEXT_MAX_CHARS)}`,
      '',
      'A conversation it applies to, which did not propose it:',
      `- title: ${clip(node.title, TITLE_MAX_CHARS)}`,
      `- question: ${clip(node.question ?? node.goal, QUESTION_MAX_CHARS)}`,
      `- last reply: ${lastReply ? clip(lastReply.body, LAST_REPLY_MAX_CHARS) : '(none yet)'}`,
      `- last changed: ${Number.isNaN(changedAt) ? 'unknown' : `${new Date(changedAt).toISOString()} (${ageInWords(now - changedAt)})`}`,
      `- status: ${HUMAN_STATUS_WORDS[node.human.status]}`,
    ];
    const newer = this.newerConversations(node);
    lines.push('', 'Newer conversations in the same project:');
    if (newer.length === 0) lines.push('- (none)');
    for (const s of newer) {
      lines.push(
        `- ${clip(s.title, TITLE_MAX_CHARS)} (started ${ageInWords(now - at(s.created_at))})`,
      );
    }
    return lines.join('\n');
  }

  private newerConversations(node: Stream): Stream[] {
    if (node.project === undefined) return [];
    const all = this.options.streams();
    const since = Date.parse(node.created_at);
    return all
      .filter(
        (s) =>
          s.id !== node.id &&
          s.project === node.project &&
          Date.parse(s.created_at) > since &&
          nodeRole(s, liveChildrenOf(s.id, all), all) === 'conversation',
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, NEWER_CONVERSATIONS_MAX);
  }

  private scopeInWords(item: KnowledgeItem): string {
    const { scope } = item;
    switch (scope.kind) {
      case 'global':
        return 'every project';
      case 'repo':
        return `the ${scope.repo} repository`;
      case 'project': {
        try {
          return `the project ${this.options.store.getProject(scope.project).name}`;
        } catch {
          return 'one project';
        }
      }
      case 'subtree': {
        const title = this.options.streams().find((s) => s.id === scope.node)?.title;
        return title !== undefined ? `"${title}" and everything under it` : 'one part of a project';
      }
    }
  }
}
