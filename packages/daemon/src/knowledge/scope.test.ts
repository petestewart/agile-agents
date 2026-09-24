/**
 * T261: stacked scopes and `paths` — projects-design §5 and the §11 step 3
 * worked example as a table. Pure: no home, no git, no vendor.
 */

import { describe, expect, test } from 'bun:test';
import {
  type KnowledgeItem,
  type KnowledgeItemInput,
  type Stream,
  ulid,
  validateKnowledgeItem,
} from '@agile-agents/shared';
import { changedFilesOf } from '../delivery/diff-rules';
import { decidePreToolUse } from '../hook/decide';
import { DEFAULT_MAX_READ_BYTES, type HookDecisionContext } from '../hook/types';
import { runPatternRules, touchedPaths } from '../permissions/rule-checks';
import { buildBrief } from '../runner/brief';
import { knowledgeInScope, knowledgeMatchesPaths, worktreeRelativePaths } from './service';

function item(text: string, over: Partial<KnowledgeItemInput> = {}): KnowledgeItem {
  return validateKnowledgeItem({
    id: `K-${ulid()}`,
    kind: 'standard',
    text,
    scope: { kind: 'global' },
    status: 'accepted',
    enforcement: 'tell',
    critical: false,
    source: { by: 'human' },
    stats: {},
    created_at: '2026-09-22T00:00:00.000Z',
    ...over,
  });
}

function node(over: Partial<Stream> = {}): Stream {
  return {
    id: ulid(),
    title: 'a node',
    goal: 'a goal',
    created_at: '2026-09-22T00:00:00.000Z',
    agent: { status: 'idle', updated_at: '2026-09-22T00:00:00.000Z' },
    human: { status: 'open' },
    sessions: [],
    ...over,
  };
}

// §11: two projects, two repos. "Show sale prices" (Shop) has api and web parts.
const shop = `P-${ulid()}`;
const blog = `P-${ulid()}`;
const parent = node({ title: 'Show sale prices', project: shop });
const apiPart = node({ title: 'api: salePrice', project: shop, repo: 'api', parent: parent.id });
const webPart = node({
  title: 'web: show salePrice',
  project: shop,
  repo: 'web',
  parent: parent.id,
});
const blogNode = node({ title: 'api: add /posts', project: blog, repo: 'api' });

const items = [
  item('global standard'),
  item('every change to prices.ts has a test', {
    scope: { kind: 'repo', repo: 'api' },
    paths: ['src/prices.ts'],
    enforcement: 'ship',
    check: { by: 'classifier', examples: [] },
  }),
  item('prices are integer cents', { kind: 'architecture', scope: { kind: 'repo', repo: 'api' } }),
  item('web standard', { scope: { kind: 'repo', repo: 'web' } }),
  item('sale prices show in red', {
    kind: 'decision',
    scope: { kind: 'project', project: shop },
    enforcement: 'ship',
    check: { by: 'classifier', examples: [] },
  }),
  item('parent contract', { kind: 'decision', scope: { kind: 'subtree', node: parent.id } }),
  item('blog decision', { kind: 'decision', scope: { kind: 'project', project: blog } }),
  item('blog subtree', { kind: 'decision', scope: { kind: 'subtree', node: blogNode.id } }),
  item('retired', { status: 'retired' }),
];

const texts = (list: KnowledgeItem[]) => list.map((i) => i.text).sort();

describe('§11 step 3: stacked scopes', () => {
  const table: Array<[string, Stream, Stream[], string[]]> = [
    [
      'web part: global, web, Shop, its parent — nothing from api or Blog',
      webPart,
      [parent],
      ['global standard', 'parent contract', 'sale prices show in red', 'web standard'],
    ],
    [
      'api part: global, api (with its path-limited standard), Shop, its parent — nothing from web or Blog',
      apiPart,
      [parent],
      [
        'every change to prices.ts has a test',
        'global standard',
        'parent contract',
        'prices are integer cents',
        'sale prices show in red',
      ],
    ],
    [
      "Blog's api node: global, api, Blog — nothing from Shop",
      blogNode,
      [],
      [
        'blog decision',
        'blog subtree',
        'every change to prices.ts has a test',
        'global standard',
        'prices are integer cents',
      ],
    ],
  ];
  for (const [name, stream, ancestors, expected] of table) {
    test(name, () => {
      expect(texts(knowledgeInScope(items, stream, ancestors))).toEqual(expected.sort());
    });
  }

  test('the web part never sees the api standard', () => {
    const seen = texts(knowledgeInScope(items, webPart, [parent]));
    expect(seen).not.toContain('every change to prices.ts has a test');
    expect(seen).not.toContain('blog decision');
  });
});

describe('paths', () => {
  const pathed = items[1] as KnowledgeItem;

  const table: Array<[string, string[], boolean]> = [
    ['matching file', ['src/prices.ts'], true],
    ['other file', ['src/cart.ts'], false],
    ['one of several', ['README.md', 'src/prices.ts'], true],
    ['no path at all', [], false],
  ];
  for (const [name, paths, expected] of table) {
    test(`path-limited item, ${name}`, () => {
      expect(knowledgeMatchesPaths(pathed, paths)).toBe(expected);
    });
  }

  test('an item with no paths matches everything, even no path', () => {
    expect(knowledgeMatchesPaths(items[0] as KnowledgeItem, [])).toBe(true);
  });

  test('ship scope for the api part filters by the changed files', () => {
    const ship = (paths: string[]) =>
      texts(knowledgeInScope(items, apiPart, [parent], 'ship', paths));
    expect(ship(['src/prices.ts'])).toEqual([
      'every change to prices.ts has a test',
      'sale prices show in red',
    ]);
    expect(ship(['src/cart.ts'])).toEqual(['sale prices show in red']);
  });

  test('tool-call paths become repo-relative; outside paths drop', () => {
    expect(
      worktreeRelativePaths(['/wt/src/prices.ts', './a.ts', 'b/c.ts', '/elsewhere/x.ts'], '/wt'),
    ).toEqual(['src/prices.ts', 'a.ts', 'b/c.ts']);
  });

  test('changed files of a diff, both sides of a rename', () => {
    const diff = [
      'diff --git a/src/prices.ts b/src/prices.ts',
      '+x',
      'diff --git a/old.ts b/new.ts',
    ].join('\n');
    expect(changedFilesOf(diff).sort()).toEqual(['new.ts', 'old.ts', 'src/prices.ts']);
  });

  test('action: a path-limited pattern rule gates only calls on its paths', () => {
    const rule = item('no edits to generated', {
      enforcement: 'action',
      paths: ['gen/**'],
      check: { by: 'pattern', pattern: { kind: 'path_deny', args: { globs: ['**'] } } },
    });
    const run = (paths: string[]) =>
      runPatternRules([rule], {
        worktreePath: '/wt',
        paths,
        writes: true,
        protectedBranches: ['main'],
        upstream: () => undefined,
        head: () => undefined,
      }).rulesEvaluated;
    expect(run(['/wt/gen/a.ts'])).toEqual([rule.id]);
    expect(run(['/wt/src/a.ts'])).toEqual([]);
  });

  test('the brief lists path-limited items under their globs', () => {
    const brief = buildBrief({
      stream: apiPart,
      ancestors: [parent],
      rules: items,
      docs: [],
      thread: [],
    } as never);
    expect(brief).toContain('- Only when touching `src/prices.ts`:');
    expect(brief).toContain('  - every change to prices.ts has a test');
    expect(brief).not.toContain('blog decision');
  });
});

describe('paths through the hook (pathsForToolCall → verdict)', () => {
  const rule = item('no echo or ls under gen', {
    enforcement: 'action',
    paths: ['gen/**'],
    check: { by: 'pattern', pattern: { kind: 'command_deny', args: { patterns: ['echo', 'ls'] } } },
  });
  const ctx: HookDecisionContext = {
    session: '01J9AAAAAAAAAAAAAAAAAAAAAA',
    stream: '01J9BBBBBBBBBBBBBBBBBBBBBB',
    role: 'worker',
    worktreePath: '/wt',
    inbox: [],
    limits: { maxReadBytes: DEFAULT_MAX_READ_BYTES },
    fileSize: () => undefined,
    patternRules: [rule],
  };
  const bash = (command: string) =>
    decidePreToolUse(ctx, { tool_name: 'Bash', tool_input: { command } });

  test('a Bash write into gen/ is denied by the gen/** rule', () => {
    const result = bash('echo x > gen/a');
    expect(result.decision).toBe('deny');
    expect(result.ruleViolated).toBe(rule.id);
  });

  test('a Bash call off the rule paths is not denied by it', () => {
    const result = bash('ls src');
    expect(result.rulesEvaluated ?? []).not.toContain(rule.id);
    expect(result.decision).not.toBe('deny');
  });

  test('a command whose paths are unknown ($VAR) never allows, and the rule pass evaluates it', () => {
    // The hook's policy tier asks first; the rule pass still fails closed on its own.
    expect(bash('echo x > $OUT').decision).not.toBe('allow');
    expect(touchedPaths({ worktreePath: '/wt', command: 'echo x > $OUT' })).toBeUndefined();
    const outcome = runPatternRules([rule], {
      worktreePath: '/wt',
      command: 'echo x > $OUT',
      paths: [],
      protectedBranches: ['main'],
      upstream: () => undefined,
      head: () => undefined,
    });
    expect(outcome.ruleViolated).toBe(rule.id);
  });
});
