/**
 * T322 (projects-design §10 "Roll-up"): a node with no link belongs to its
 * nearest linked ancestor. Its PR mentions that issue, and its progress
 * counts toward it: a linked node shows how many of the nodes rolling up to
 * it have merged.
 */

import type { Stream } from '@agile-agents/shared';

type Link = NonNullable<Stream['external_link']>;

/** The node's own link, else its nearest linked ancestor's; `undefined` when none. */
export function rollupLink(
  stream: Stream,
  lookup: (id: string) => Stream | undefined,
): Link | undefined {
  const seen = new Set<string>();
  let current: Stream | undefined = stream;
  while (current !== undefined && !seen.has(current.id)) {
    if (current.external_link !== undefined) return current.external_link;
    seen.add(current.id);
    current = current.parent === undefined ? undefined : lookup(current.parent);
  }
  return undefined;
}

/**
 * A linked node's progress: the live descendants that roll up to it (its
 * own nearest link, not a nearer linked node's) and how many have merged.
 * `undefined` for an unlinked node or one with nothing rolling up.
 */
export function rollupProgress(
  node: Stream,
  all: Stream[],
): { merged: number; total: number } | undefined {
  if (node.external_link === undefined) return undefined;
  const children = new Map<string, Stream[]>();
  for (const s of all) {
    if (s.parent === undefined || s.archived === true || s.human.status === 'closed') continue;
    const list = children.get(s.parent) ?? [];
    list.push(s);
    children.set(s.parent, list);
  }
  let merged = 0;
  let total = 0;
  const seen = new Set<string>([node.id]);
  const queue = [...(children.get(node.id) ?? [])];
  while (queue.length > 0) {
    const s = queue.shift() as Stream;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    total += 1;
    if (s.delivery_state?.status === 'merged') merged += 1;
    // A linked descendant counts once here; its own subtree rolls up to it.
    if (s.external_link === undefined) queue.push(...(children.get(s.id) ?? []));
  }
  return total > 0 ? { merged, total } : undefined;
}
