/** T429: replies you haven't read. */

import { describe, expect, test } from 'bun:test';
import type { CockpitStreamRow } from './feed-types';
import {
  DIRECTOR_READ_KEY,
  SEEN_MAX,
  ancestorTitles,
  answersYou,
  directorUnread,
  markAllSeen,
  markSeen,
  parseSeen,
  unreadReplies,
} from './unread';

const row = (over: Partial<CockpitStreamRow> & { id: string }): CockpitStreamRow => ({
  title: over.id,
  role: 'conversation',
  agent_status: 'done',
  human_status: 'open',
  updated_at: '2026-09-26T10:00:00.000Z',
  ...over,
});

describe('which nodes answer you', () => {
  test('a finished conversation, root or coordinator; never a work node (its Merge card is in Needs me)', () => {
    expect(answersYou(row({ id: 'c' }))).toBe(true);
    expect(answersYou(row({ id: 'r', role: 'project' }))).toBe(true);
    expect(answersYou(row({ id: 'k', role: 'coordinating' }))).toBe(true);
    expect(answersYou(row({ id: 'w', role: 'work' }))).toBe(false);
    expect(answersYou(row({ id: 'busy', agent_status: 'working' }))).toBe(false);
    expect(answersYou(row({ id: 'shut', human_status: 'closed' }))).toBe(false);
    expect(answersYou(row({ id: 'old', updated_at: undefined }))).toBe(false);
  });
});

describe('unread replies', () => {
  const seen = parseSeen(null, '2026-09-26T09:00:00.000Z');

  test('a reply after the first visit is unread until read up to its last change', () => {
    const rows = [
      row({ id: 'a', updated_at: '2026-09-26T10:00:00.000Z' }),
      row({ id: 'b', updated_at: '2026-09-26T11:00:00.000Z' }),
      row({ id: 'before', updated_at: '2026-09-26T08:00:00.000Z' }),
    ];
    expect(unreadReplies(rows, seen).map((r) => r.id)).toEqual(['b', 'a']);
    const read = markSeen(seen, 'b', '2026-09-26T11:00:00.000Z');
    expect(unreadReplies(rows, read).map((r) => r.id)).toEqual(['a']);
    // It answers again: unread again.
    const again = [...rows.slice(0, 1), row({ id: 'b', updated_at: '2026-09-26T12:00:00.000Z' })];
    expect(unreadReplies(again, read).map((r) => r.id)).toEqual(['b', 'a']);
  });

  test('the node open now is being read', () => {
    expect(unreadReplies([row({ id: 'a' })], seen, 'a')).toEqual([]);
  });

  test('marking is idempotent, never goes back, and keeps the newest marks', () => {
    const once = markSeen(seen, 'a', '2026-09-26T10:00:00.000Z');
    expect(markSeen(once, 'a', '2026-09-26T10:00:00.000Z')).toBe(once);
    expect(markSeen(once, 'a', '2026-09-26T09:30:00.000Z')).toBe(once);
    let many = seen;
    for (let i = 0; i < SEEN_MAX + 5; i++) {
      many = markSeen(many, `n${i}`, new Date(Date.UTC(2026, 8, 26, 10, 0, i)).toISOString());
    }
    expect(Object.keys(many.nodes)).toHaveLength(SEEN_MAX);
    expect(many.nodes.n0).toBeUndefined();
    expect(many.nodes[`n${SEEN_MAX + 4}`]).toBeDefined();
  });

  test('Mark all read reads each reply up to its last change', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', updated_at: '2026-09-26T11:00:00.000Z' })];
    expect(unreadReplies(rows, markAllSeen(seen, rows))).toEqual([]);
  });
});

describe('the stored marks', () => {
  test('parsed when well formed; a fresh start otherwise', () => {
    const now = '2026-09-26T09:00:00.000Z';
    expect(parseSeen('{"since":"x","nodes":{"a":"y","b":3}}', now)).toEqual({
      since: 'x',
      nodes: { a: 'y' },
    });
    expect(parseSeen('not json', now)).toEqual({ since: now, nodes: {} });
    expect(parseSeen('{"nodes":{}}', now)).toEqual({ since: now, nodes: {} });
    expect(parseSeen(undefined, now)).toEqual({ since: now, nodes: {} });
  });
});

describe('ancestorTitles', () => {
  test('the titles above a node, its root first', () => {
    const rows = [
      { id: 'root', title: 'Shop' },
      { id: 'mid', title: 'Checkout', parent: 'root' },
      { id: 'leaf', title: 'Why buffer?', parent: 'mid' },
    ];
    expect(ancestorTitles(rows, 'leaf')).toEqual(['Shop', 'Checkout']);
    expect(ancestorTitles(rows, 'root')).toEqual([]);
    expect(ancestorTitles(rows, 'gone')).toEqual([]);
  });
});

describe('the Director (T433)', () => {
  const seen = parseSeen(null, '2026-09-26T09:00:00.000Z');
  test('its reply is unread until its page is read up to it', () => {
    expect(directorUnread(undefined, seen, false)).toBe(false);
    expect(directorUnread('2026-09-26T08:00:00.000Z', seen, false)).toBe(false);
    expect(directorUnread('2026-09-26T10:00:00.000Z', seen, false)).toBe(true);
    expect(directorUnread('2026-09-26T10:00:00.000Z', seen, true)).toBe(false);
    const read = markSeen(seen, DIRECTOR_READ_KEY, '2026-09-26T10:00:00.000Z');
    expect(directorUnread('2026-09-26T10:00:00.000Z', read, false)).toBe(false);
    expect(directorUnread('2026-09-26T11:00:00.000Z', read, false)).toBe(true);
  });
});
