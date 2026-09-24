/** T241: the router over the worked example tree (projects-design §11, §15). Pure, plus one routeAndEmit pass. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RoutedEventType, type Stream, ulid } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { type RouteInput, routeAndEmit, routeEvent } from './router';
import { RoutedEventService } from './service';

const at = '2026-09-24T00:00:00.000Z';
function node(title: string, patch: Partial<Stream> = {}): Stream {
  return { id: ulid(), title, goal: title, human: { status: 'active' }, ...patch } as Stream;
}

// Shop: root > "Show sale prices" > api part, web part. Blog: root > "api: add /posts".
const shop = node('Shop');
const sale = node('Show sale prices', { parent: shop.id });
const blog = node('Blog');
const posts = node('api: add /posts', { parent: blog.id, repo: 'api' });
const apiPart = node('api: add salePrice', {
  parent: sale.id,
  repo: 'api',
  waits_on: [{ node: posts.id, added_by: 'human', added_at: at }],
});
const webPart = node('web: show sale', {
  parent: sale.id,
  repo: 'web',
  waits_on: [{ node: apiPart.id, added_by: 'coordinator', added_at: at }],
});
const tree = [shop, sale, blog, posts, apiPart, webPart];
// After Blog's merge the posts node is delivered: no longer live work.
const merged = tree.map((s) =>
  s.id === posts.id ? ({ ...s, delivery_state: { status: 'merged' } } as unknown as Stream) : s,
);

const name = new Map(tree.map((s) => [s.id, s.title]));
const route = (input: RouteInput, all = tree) =>
  routeEvent(input, all).routing.map((r) => [name.get(r.node), r.because]);

describe('routeEvent over the worked example (T241)', () => {
  const cases: [string, RouteInput, (string | undefined)[][]][] = [
    [
      "Blog's merge: child_delivered reaches its parent",
      { type: 'child_delivered', subject: posts.id },
      [['Blog', 'ancestor']],
    ],
    [
      "Blog's merge: main_changed reaches Shop's api part, nothing on web",
      { type: 'main_changed', subject: posts.id, repo: 'api' },
      [['api: add salePrice', 'same_repo']],
    ],
    [
      "Blog's merge: pr_merged goes to self, ancestors and waits-on",
      { type: 'pr_merged', subject: posts.id, repo: 'api' },
      [
        ['api: add /posts', 'self'],
        ['Blog', 'ancestor'],
        ['api: add salePrice', 'waits_on'],
      ],
    ],
    [
      'dependency_satisfied goes across waits-on only',
      { type: 'dependency_satisfied', subject: apiPart.id },
      [['web: show sale', 'waits_on']],
    ],
    [
      'child_status walks every ancestor to the root',
      { type: 'child_status', subject: webPart.id },
      [
        ['Show sale prices', 'ancestor'],
        ['Shop', 'ancestor'],
      ],
    ],
    [
      'human_line is self only',
      { type: 'human_line', subject: sale.id },
      [['Show sale prices', 'self']],
    ],
    [
      'overlap: both nodes and their ancestors',
      { type: 'overlap', subject: apiPart.id, repo: 'api', parties: [posts.id] },
      [
        ['api: add salePrice', 'self'],
        ['Show sale prices', 'ancestor'],
        ['Shop', 'ancestor'],
        ['api: add /posts', 'party'],
        ['Blog', 'ancestor'],
      ],
    ],
    [
      'sibling_ask: the other sibling, the parent a copy',
      { type: 'sibling_ask', subject: apiPart.id, siblings: [webPart.id] },
      [
        ['web: show sale', 'sibling'],
        ['Show sale prices', 'ancestor'],
      ],
    ],
    [
      'contract_changed: the owner and the parties',
      { type: 'contract_changed', subject: sale.id, parties: [apiPart.id, webPart.id] },
      [
        ['Show sale prices', 'self'],
        ['api: add salePrice', 'party'],
        ['web: show sale', 'party'],
      ],
    ],
  ];
  for (const [label, input, want] of cases) {
    test(label, () => {
      expect(route(input, merged)).toEqual(want);
    });
  }

  test('main_changed on web reaches only the web part; the subject is never same_repo', () => {
    expect(route({ type: 'main_changed', repo: 'web' })).toEqual([['web: show sale', 'same_repo']]);
    expect(route({ type: 'main_changed', subject: posts.id, repo: 'api' })).toEqual([
      ['api: add salePrice', 'same_repo'],
    ]);
  });

  test('same_repo skips coordinating and closed nodes; coalesce key is per repo', () => {
    const closed = tree.map((s) =>
      s.id === posts.id ? ({ ...s, human: { status: 'closed' } } as Stream) : s,
    );
    const r = routeEvent({ type: 'main_changed', repo: 'api' }, closed);
    expect(r.routing.map((x) => x.node)).toEqual([apiPart.id]);
    expect(r.coalesce_key).toBe('main_changed:api');
    expect(routeEvent({ type: 'human_line', subject: sale.id }, tree).coalesce_key).toBeUndefined();
  });

  test('a closed recipient is listed as expired', () => {
    const closed = tree.map((s) =>
      s.id === blog.id ? ({ ...s, human: { status: 'closed' } } as Stream) : s,
    );
    const r = routeEvent({ type: 'child_delivered', subject: posts.id }, closed);
    expect(r.expired).toEqual([blog.id]);
  });

  test('every type has a route', () => {
    for (const t of ['human_line', 'director_request'] as RoutedEventType[]) {
      expect(routeEvent({ type: t, subject: sale.id }, tree).routing.length).toBe(1);
    }
  });
});

describe('routeAndEmit (T241)', () => {
  let home: string;
  let events: RoutedEventService;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agile-router-'));
    events = new RoutedEventService(StateStore.open(runInit(home).stateRoot));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const mainChanged = (sha: string) => ({
    type: 'main_changed' as const,
    repo: 'api',
    payload: { repo: 'api', sha, outcome: 'synced' as const },
    by: 'daemon' as const,
  });

  test('a newer main_changed supersedes the pending older one for the same repo', async () => {
    const first = await routeAndEmit(events, mainChanged('a1'), merged);
    const second = await routeAndEmit(events, mainChanged('b2'), merged);
    expect(second.coalesce_key).toBe('main_changed:api');
    expect(second.routing).toEqual([{ node: apiPart.id, because: 'same_repo' }]);
    expect(events.pendingFor(apiPart.id).map((p) => p.event.id)).toEqual([second.id]);
    expect(first.id).not.toBe(second.id);
  });

  test('a closed node gets its delivery expired, the rest stay pending', async () => {
    const closed = tree.map((s) =>
      s.id === blog.id ? ({ ...s, human: { status: 'closed' } } as Stream) : s,
    );
    const e = await routeAndEmit(
      events,
      {
        type: 'pr_closed',
        subject: posts.id,
        payload: { pr: 3 },
        by: 'daemon',
      },
      closed,
    );
    expect(e.routing.map((r) => r.node)).toEqual([posts.id, blog.id]);
    expect(events.pendingFor(blog.id)).toEqual([]);
    expect(events.pendingFor(posts.id).map((p) => p.event.id)).toEqual([e.id]);
  });
});
