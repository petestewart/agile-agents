/**
 * T283 (projects-design §14.5): status cards. `cards/<node>.yaml` follows
 * the node record: the daemon recomputes `state`, `files` and `relies_on`
 * on every stream update (so a `touched` recompute moves the card with
 * it). `doing` is the `progress` verb's line (`agent.progress`), which
 * reaches the card through the same update. `read_card` is limited to the
 * caller's siblings and ancestors, plus the Director.
 */

import {
  CARD_DOING_MAX,
  CARD_FILES_MAX,
  type CardState,
  type StatusCard,
  type Stream,
} from '@agile-agents/shared';
import type { StateStore } from '../store';

const DONE_DELIVERY = new Set(['merged', 'closed_unmerged']);

/** The card's `state` from the node's two status halves and its delivery. */
export function cardState(s: Stream): CardState {
  if (s.human.status === 'landed' || s.human.status === 'closed') return 'done';
  if (s.delivery_state !== undefined && DONE_DELIVERY.has(s.delivery_state.status)) return 'done';
  switch (s.agent.status) {
    case 'question':
    case 'blocked':
      return 'blocked';
    case 'working':
      return 'working';
    case 'done':
      return 'done';
    default:
      return 'idle';
  }
}

/** The latest `progress` line: its first line, ≤ 200 characters. */
export function cardDoing(s: Stream): string {
  const text = s.agent.progress ?? '';
  return (text.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, CARD_DOING_MAX);
}

/** `touched.files`, capped at 200 with one "+N more" line. */
export function cardFiles(s: Stream): string[] {
  const files = s.touched?.files ?? [];
  if (files.length <= CARD_FILES_MAX) return [...files];
  return [...files.slice(0, CARD_FILES_MAX), `+${files.length - CARD_FILES_MAX} more`];
}

/** True when `target` is a sibling (same parent) or an ancestor of `caller`. */
export function canReadCard(caller: string, target: string, all: readonly Stream[]): boolean {
  if (caller === target) return true;
  const byId = new Map(all.map((s) => [s.id, s]));
  const self = byId.get(caller);
  const other = byId.get(target);
  if (self === undefined || other === undefined) return false;
  if (self.parent !== undefined && self.parent === other.parent) return true;
  const seen = new Set<string>();
  for (let cur = self.parent; cur !== undefined && !seen.has(cur); cur = byId.get(cur)?.parent) {
    if (cur === target) return true;
    seen.add(cur);
  }
  return false;
}

export interface CardServiceOptions {
  store: StateStore;
  streams: { list(): Stream[]; get(id: string): Stream };
  /**
   * The contracts the node relies on. Contracts land with T281/T285; until
   * then the card keeps whatever it had (empty on a new card).
   */
  reliesOn?: (node: Stream) => string[] | undefined;
  /**
   * The Director (§14.11) reads every card. It doesn't exist yet: when it
   * does, this answers true for the Director's stream and `read` skips the
   * sibling/ancestor check.
   */
  isDirector?: (stream: string) => boolean;
  now?: () => Date;
}

export class CardService {
  constructor(private readonly options: CardServiceOptions) {}

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  /** Recomputes the daemon's fields; writes only when one of them changed. */
  async refresh(stream: Stream): Promise<StatusCard | undefined> {
    return this.options.store.updateCard(stream.id, (before) => {
      const next = {
        node: stream.id,
        doing: cardDoing(stream),
        state: cardState(stream),
        files: cardFiles(stream),
        exports_changed: before?.exports_changed ?? [],
        relies_on: this.options.reliesOn?.(stream) ?? before?.relies_on ?? [],
      };
      if (before !== undefined && sameCard(before, next)) return undefined;
      return { ...next, updated_at: this.now() };
    });
  }

  /** `read_card`: a sibling's or ancestor's card (any card for the Director). */
  read(caller: string, target: string): StatusCard {
    const all = this.options.streams.list();
    const allowed = this.options.isDirector?.(caller) === true || canReadCard(caller, target, all);
    if (!allowed) {
      throw new Error(`read_card: ${target} is not a sibling or an ancestor of this node`);
    }
    const stream = all.find((s) => s.id === target);
    if (stream === undefined) throw new Error(`read_card: no node ${target}`);
    return (
      this.options.store.getCard(target) ?? {
        node: target,
        doing: cardDoing(stream),
        state: cardState(stream),
        files: cardFiles(stream),
        exports_changed: [],
        relies_on: this.options.reliesOn?.(stream) ?? [],
        updated_at: this.now(),
      }
    );
  }
}

function sameCard(a: StatusCard, b: Omit<StatusCard, 'updated_at'>): boolean {
  const key = (c: Omit<StatusCard, 'updated_at'>) =>
    JSON.stringify([c.doing, c.state, c.files, c.exports_changed, c.relies_on]);
  return key(a) === key(b);
}
