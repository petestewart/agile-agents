/**
 * T302 (projects-design §12): the Director's cross-project digest, as an
 * exact snapshot, and the stuck-node rule.
 */

import { describe, expect, test } from 'bun:test';
import type { InboxItem, KnowledgeItem, Project, Stream } from '@agile-agents/shared';
import { directorDigest, findStuck, stuckAfterMs } from './sight';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const A = '01J0000000000000000000000A';
const B = '01J0000000000000000000000B';
const C = '01J0000000000000000000000C';
const D = '01J0000000000000000000000D';

function node(id: string, title: string, project: string, extra: Partial<Stream> = {}): Stream {
  return {
    id,
    title,
    project,
    parent: '01J00000000000000000000ROT',
    repo: 'ledger-lite',
    agent: { status: 'idle', updated_at: ago(0) },
    human: { status: 'open' },
    ...extra,
  } as unknown as Stream;
}

function project(id: string, name: string, director: 'advise' | 'organise' | 'run'): Project {
  return { id, name, autonomy: { coordinator: 'advise', director } } as unknown as Project;
}

const projects = [project('P-SHOP', 'Shop', 'advise'), project('P-BLOG', 'Blog', 'organise')];
const streams = [
  node(A, 'Sale prices api', 'P-SHOP', {
    agent: { status: 'working', updated_at: ago(3 * HOUR) },
    touched: { files: ['src/prices.ts', 'src/api.ts'] },
    waits_on: [{ node: C, added_by: 'human', added_at: ago(HOUR) }],
  } as Partial<Stream>),
  node(B, 'Checkout', 'P-SHOP', {
    agent: { status: 'working', updated_at: ago(2 * HOUR) },
  }),
  node(C, 'Posts api', 'P-BLOG', {
    agent: { status: 'working', updated_at: ago(5 * 60_000) },
    touched: { files: ['src/api.ts'] },
  } as Partial<Stream>),
  node(D, 'Old draft', 'P-BLOG', { human: { status: 'closed' } }),
];
const inbox = [
  {
    kind: 'question',
    id: 'Q-1',
    stream: B,
    stream_path: ['Shop', 'Checkout'],
    ts: ago(HOUR),
    context: 'Which currency?',
  },
] as InboxItem[];
const knowledge = [
  {
    id: 'K-1',
    kind: 'standard',
    name: 'no-float-money',
    text: 'Money is integer cents, never floats.',
    scope: { kind: 'project', project: 'P-BLOG' },
    status: 'accepted',
  },
  {
    id: 'K-2',
    kind: 'standard',
    text: 'global one',
    scope: { kind: 'global' },
    status: 'accepted',
  },
] as unknown as KnowledgeItem[];

// B's thread moved 10 minutes ago: not stuck, although its agent half is old.
const lastThreadTs = (id: string) => (id === B ? ago(10 * 60_000) : undefined);

describe('T302: the Director digest', () => {
  test('snapshot: projects, overlaps, waits-on, stuck, norms and the inbox', () => {
    const digest = directorDigest({
      streams,
      projects,
      inbox,
      knowledge,
      lastThreadTs,
      now: NOW,
      stuckAfterMs: HOUR,
    });
    expect(digest).toBe(
      [
        '## Snapshot (2026-09-24T12:00:00.000Z)',
        '',
        '### Projects',
        '- Shop [P-SHOP] (director: advise): 2 working',
        '- Blog [P-BLOG] (director: organise): 1 working',
        '',
        '### Overlaps (two live nodes changing the same files)',
        '- Sale prices api (Shop) and Posts api (Blog) on ledger-lite: src/api.ts',
        '',
        '### Waits on (open)',
        '- Sale prices api (Shop) waits on Posts api (Blog) [working]',
        '',
        '### Stuck (working, idle over 60 min)',
        `- Sale prices api (Shop) [${A}]: working, no activity for 180 min`,
        '',
        '### Project norms (check work in one project against another’s)',
        '- Blog standard "no-float-money": Money is integer cents, never floats.',
        '',
        '### Inbox (1 waiting on the operator)',
        '- question on Checkout (Shop): Which currency?',
      ].join('\n'),
    );
  });

  test('stuck uses the configured threshold', () => {
    const at = (minutes: number) =>
      findStuck({ streams, lastThreadTs, now: NOW, stuckAfterMs: minutes * 60_000 }).map(
        (s) => s.node,
      );
    expect(at(60)).toEqual([A]);
    expect(at(4)).toEqual([A, B, C]);
    expect(at(240)).toEqual([]);
    expect(stuckAfterMs({})).toBe(HOUR);
    expect(stuckAfterMs({ director: { stuck_after_minutes: 15 } })).toBe(15 * 60_000);
  });
});
