/** T322: roll-up resolution and progress, on plain records. */

import { describe, expect, test } from 'bun:test';
import type { Stream } from '@agile-agents/shared';
import { rollupLink, rollupProgress } from './rollup';

function link(key: string): NonNullable<Stream['external_link']> {
  return {
    system: 'jira',
    key,
    url: `https://jira.example/browse/${key}`,
    synced: { title: key, description_hash: 'h', at: '2026-09-25T10:00:00Z' },
  };
}
function node(id: string, extra: Partial<Stream> = {}): Stream {
  return { id, title: id, goal: id, human: { status: 'open' }, agent: {}, ...extra } as Stream;
}

// SHOP-10 epic → SHOP-11 → api, web (unlinked); SHOP-11 → SHOP-12 → leaf.
const epic = node('epic', { external_link: link('SHOP-10') });
const feature = node('feature', { parent: 'epic', external_link: link('SHOP-11') });
const api = node('api', {
  parent: 'feature',
  delivery_state: { mode: 'pr', status: 'merged', at: 'x' },
});
const web = node('web', { parent: 'feature' });
const sub = node('sub', { parent: 'feature', external_link: link('SHOP-12') });
const leaf = node('leaf', {
  parent: 'sub',
  delivery_state: { mode: 'direct', status: 'merged', at: 'x' },
});
const closed = node('closed', {
  parent: 'feature',
  human: { status: 'closed' },
} as Partial<Stream>);
const loose = node('loose');
const all = [epic, feature, api, web, sub, leaf, closed, loose];
const lookup = (id: string) => all.find((s) => s.id === id);

describe('rollupLink', () => {
  test('an unlinked node resolves to its nearest linked ancestor', () => {
    expect(rollupLink(api, lookup)?.key).toBe('SHOP-11');
    expect(rollupLink(leaf, lookup)?.key).toBe('SHOP-12');
  });
  test('a linked node is its own issue; one with no linked ancestor has none', () => {
    expect(rollupLink(feature, lookup)?.key).toBe('SHOP-11');
    expect(rollupLink(loose, lookup)).toBeUndefined();
  });
  test('a missing or cyclic parent stops the walk', () => {
    const a = node('a', { parent: 'b' });
    const b = node('b', { parent: 'a' });
    expect(rollupLink(a, (id) => (id === 'b' ? b : id === 'a' ? a : undefined))).toBeUndefined();
    expect(rollupLink(node('x', { parent: 'gone' }), () => undefined)).toBeUndefined();
  });
});

describe('rollupProgress', () => {
  test('counts live descendants up to the next linked node', () => {
    // api (merged), web, sub; not leaf (rolls up to SHOP-12), not closed.
    expect(rollupProgress(feature, all)).toEqual({ merged: 1, total: 3 });
    expect(rollupProgress(sub, all)).toEqual({ merged: 1, total: 1 });
    expect(rollupProgress(epic, all)).toEqual({ merged: 0, total: 1 });
  });
  test('none for an unlinked node or a linked one with no children', () => {
    expect(rollupProgress(api, all)).toBeUndefined();
    expect(rollupProgress(node('solo', { external_link: link('SHOP-9') }), all)).toBeUndefined();
  });
});
