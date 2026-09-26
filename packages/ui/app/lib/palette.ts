/**
 * T368: the command palette's matching and ranking (⌘K / Ctrl K). Pure:
 * the component (`components/CommandPalette.tsx`) builds the entries from
 * the cockpit frame and runs the one picked; everything here is data in,
 * ranked groups out, so `bun test` covers it.
 */

export type PaletteGroupId = 'recent' | 'nodes' | 'projects' | 'views' | 'actions';

export const GROUP_LABEL: Record<PaletteGroupId, string> = {
  recent: 'Recent',
  nodes: 'Nodes',
  projects: 'Projects',
  views: 'Go to',
  actions: 'Actions',
};

export interface PaletteEntry {
  /** Unique across the palette: `node:<id>`, `view:repos`, `action:new-node`. */
  key: string;
  group: Exclude<PaletteGroupId, 'recent'>;
  title: string;
  /** A node's path ("Shop › Show sale prices"), or a view's one-line hint. */
  subtitle?: string;
  /** Other words it answers to ("inbox" for Needs me). Matched, never shown. */
  keywords?: readonly string[];
}

export interface PaletteGroup {
  id: PaletteGroupId;
  label: string;
  items: PaletteEntry[];
}

const WORD_START = /[\s\-_/.:›(]/;

/**
 * How well `query` (one word, lower case) matches `text`: 0 is no match.
 * A prefix beats a word start beats a substring beats a subsequence
 * (`csvim` finds "CSV import"); shorter texts win ties.
 */
export function fuzzyScore(query: string, text: string, subsequence = true): number {
  const q = query.trim().toLowerCase();
  if (q === '') return 1;
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at === 0) return 1000 - Math.min(t.length, 200);
  if (at > 0) {
    // Any occurrence that starts a word ("sale" in "show sale prices") beats a mid-word one.
    for (let i = at; i !== -1; i = t.indexOf(q, i + 1)) {
      if (WORD_START.test(t[i - 1] ?? ' ')) {
        return 800 - Math.min(i, 100) - Math.min(t.length, 200) / 10;
      }
    }
    return 600 - Math.min(at, 100) - Math.min(t.length, 200) / 10;
  }
  if (!subsequence) return 0;
  // Subsequence: every character in order, rewarding runs and word starts.
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0;
    const gap = found - ti;
    run = gap === 0 && ti > 0 ? run + 1 : 0;
    score += 10 + run * 8 + (WORD_START.test(t[found - 1] ?? ' ') ? 12 : 0) - Math.min(gap, 10);
    ti = found + 1;
  }
  // A scattered match of a short query is noise: "ae" is in half the titles.
  if (q.length < 3 && score < 40) return 0;
  return Math.max(1, Math.min(score, 400));
}

/**
 * An entry's score for a whole query: every word must match its title,
 * its subtitle or a keyword (the title counts most), so "shop csv" finds
 * "Add CSV import" under Shop. Only the title matches loosely (a
 * subsequence): letters scattered through a long subtitle are noise.
 * 0 is no match.
 */
export function scoreEntry(query: string, entry: PaletteEntry): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let total = 0;
  for (const word of words) {
    const best = Math.max(
      fuzzyScore(word, entry.title),
      fuzzyScore(word, entry.subtitle ?? '', false) * 0.5,
      ...(entry.keywords ?? []).map((k) => fuzzyScore(word, k, false) * 0.8),
    );
    if (best <= 0) return 0;
    total += best;
  }
  // The whole query as typed, inside the title, beats the same words scattered.
  if (words.length > 1 && entry.title.toLowerCase().includes(query.trim().toLowerCase())) {
    total += 200;
  }
  return total;
}

/** Per group, at most this many results for a typed query. */
const GROUP_LIMIT: Record<Exclude<PaletteGroupId, 'recent'>, number> = {
  nodes: 8,
  projects: 4,
  views: 8,
  actions: 6,
};

const GROUP_ORDER: readonly Exclude<PaletteGroupId, 'recent'>[] = [
  'nodes',
  'projects',
  'views',
  'actions',
];

/**
 * The palette's list. With no query: the recent nodes (most recent first),
 * then every view and action. With a query: each group's matches, best
 * first, and the groups ordered by their best match, so Enter on the first
 * row runs the best one.
 */
export function paletteResults(
  query: string,
  entries: readonly PaletteEntry[],
  recent: readonly string[] = [],
): PaletteGroup[] {
  const q = query.trim();
  if (q === '') {
    const byKey = new Map(entries.map((e) => [e.key, e]));
    const recentItems = recent
      .map((id) => byKey.get(`node:${id}`))
      .filter((e): e is PaletteEntry => e !== undefined)
      .slice(0, 5);
    const groups: PaletteGroup[] = [];
    if (recentItems.length > 0) {
      groups.push({ id: 'recent', label: GROUP_LABEL.recent, items: recentItems });
    }
    for (const id of ['views', 'actions'] as const) {
      const items = entries.filter((e) => e.group === id);
      if (items.length > 0) groups.push({ id, label: GROUP_LABEL[id], items });
    }
    return groups;
  }
  const recentRank = new Map(recent.map((id, i) => [`node:${id}`, i]));
  const scored = entries
    .map((entry, i) => ({ entry, i, score: scoreEntry(q, entry) }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (recentRank.get(a.entry.key) ?? 99) - (recentRank.get(b.entry.key) ?? 99) ||
        a.i - b.i,
    );
  const groups = GROUP_ORDER.map((id) => {
    const hits = scored.filter((x) => x.entry.group === id).slice(0, GROUP_LIMIT[id]);
    return { id, best: hits[0]?.score ?? 0, items: hits.map((x) => x.entry) };
  }).filter((g) => g.items.length > 0);
  return groups
    .map((g, order) => ({ ...g, order }))
    .sort((a, b) => b.best - a.best || a.order - b.order)
    .map(({ id, items }) => ({ id, label: GROUP_LABEL[id], items }));
}

/** The groups flattened in display order: what the arrow keys walk. */
export function flatResults(groups: readonly PaletteGroup[]): PaletteEntry[] {
  return groups.flatMap((g) => g.items);
}

/** Moves the highlighted row by `delta`, wrapping at both ends. */
export function moveActive(active: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((active + delta) % count) + count) % count;
}

// ---------------------------------------------------------------- recent nodes

export const RECENT_MAX = 8;

/** `id` to the front of the recent list, once, capped. */
export function pushRecent(recent: readonly string[], id: string, max = RECENT_MAX): string[] {
  return [id, ...recent.filter((each) => each !== id)].slice(0, max);
}

/** The recent list read back from storage; anything malformed is empty. */
export function parseRecent(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string').slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- keys

/** A Mac says ⌘; everything else says Ctrl. */
export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function modKeyLabel(platform: string): string {
  return isMacPlatform(platform) ? '⌘' : 'Ctrl';
}

/** ⌘K or Ctrl K (either, on any platform), with no other modifier. */
export function isPaletteKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'k'
  );
}
