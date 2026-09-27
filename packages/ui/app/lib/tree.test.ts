/** T365: the rail's pure helpers — New node's defaults and title, Move to…, Delete, the legend. */

import { describe, expect, test } from 'bun:test';
import type { CockpitProjectRow, CockpitStreamRow } from './feed-types';
import { nodeStatus } from './status';
import { streamDot } from './streams';
import {
  LEGEND_NOTE,
  LEGEND_ORDER,
  checkMove,
  deleteQuestion,
  filesText,
  legendRow,
  moveTargets,
  newNodeDefaults,
  outline,
  overlapMark,
  pickHighlight,
  projectOutline,
  searchOutline,
  splitRepos,
  subtreeIds,
  titleFromGoal,
  typeAheadMatch,
} from './tree';

function row(id: string, extra: Partial<CockpitStreamRow> = {}): CockpitStreamRow {
  return { id, title: id, role: 'work', agent_status: 'idle', human_status: 'open', ...extra };
}

// Shop: root ─ a ─ a1 ─ a1x
//                └ a2
//         └ b
// Blog: root2 ─ c
const ROWS: CockpitStreamRow[] = [
  row('root', { role: 'project', project: 'P-shop', title: 'Shop' }),
  row('a', { parent: 'root', project: 'P-shop', role: 'coordinating' }),
  row('a1', { parent: 'a', project: 'P-shop', role: 'coordinating' }),
  row('a1x', { parent: 'a1', project: 'P-shop' }),
  row('a2', { parent: 'a', project: 'P-shop' }),
  row('b', { parent: 'root', project: 'P-shop', role: 'conversation' }),
  row('root2', { role: 'project', project: 'P-blog', title: 'Blog' }),
  row('c', { parent: 'root2', project: 'P-blog' }),
];
const PROJECTS: CockpitProjectRow[] = [
  { id: 'P-shop', name: 'Shop', root: 'root' },
  { id: 'P-blog', name: 'Blog', root: 'root2' },
];

describe('titleFromGoal', () => {
  test('the first non-empty line, markers stripped', () => {
    expect(titleFromGoal('\n\n  Fix the login bug  \nIt 500s on submit.')).toBe(
      'Fix the login bug',
    );
    expect(titleFromGoal('# Import CSV\nwith a header row')).toBe('Import CSV');
    expect(titleFromGoal('- make exports faster')).toBe('make exports faster');
    expect(titleFromGoal('1. research pricing')).toBe('research pricing');
    expect(titleFromGoal('> why is the nightly export slow?')).toBe(
      'why is the nightly export slow?',
    );
    expect(titleFromGoal('   ')).toBe('');
  });

  test('T413: a long line is cut at a word, at most 60 characters, with no ellipsis', () => {
    const goal =
      'Compare the pricing pages of three competitors and write up what each tier includes, what it costs and who it is for';
    const title = titleFromGoal(goal);
    expect(title).toBe('Compare the pricing pages of three competitors and write up');
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.includes('…')).toBe(false);
    expect(goal.startsWith(title)).toBe(true);
    // A cut never ends on a comma or a dash.
    expect(titleFromGoal(`${'a'.repeat(50)}, bbbbbbbbbbbb cccc`)).toBe('a'.repeat(50));
    // One word longer than the limit is cut at the limit.
    expect(titleFromGoal('x'.repeat(70))).toBe('x'.repeat(60));
    // Exactly the limit stays whole.
    expect(titleFromGoal('y'.repeat(60))).toBe('y'.repeat(60));
  });
});

describe('subtreeIds and deleteQuestion', () => {
  test('a node and everything under it, itself first', () => {
    expect(subtreeIds(ROWS, 'a')).toEqual(['a', 'a1', 'a1x', 'a2']);
    expect(subtreeIds(ROWS, 'b')).toEqual(['b']);
    expect(subtreeIds(ROWS, 'nope')).toEqual(['nope']);
  });

  test('a cycle in bad data does not loop', () => {
    const loop = [row('x', { parent: 'y' }), row('y', { parent: 'x' })];
    expect(subtreeIds(loop, 'x')).toEqual(['x', 'y']);
  });

  test('the question counts the nodes under it', () => {
    expect(deleteQuestion('Checkout', 0)).toBe('Delete “Checkout”?');
    expect(deleteQuestion('Checkout', 1)).toBe('Delete “Checkout” and the node under it?');
    expect(deleteQuestion('Checkout', 3)).toBe('Delete “Checkout” and the 3 nodes under it?');
  });
});

describe('checkMove', () => {
  test('a valid move within the project', () => {
    expect(checkMove(ROWS, 'b', 'a2')).toEqual({ ok: true });
    expect(checkMove(ROWS, 'a1x', 'root')).toEqual({ ok: true });
  });

  test('onto itself or where it already is: quiet', () => {
    expect(checkMove(ROWS, 'a1', 'a1')).toEqual({ ok: false, quiet: true });
    expect(checkMove(ROWS, 'a1', 'a')).toEqual({ ok: false, quiet: true });
    expect(checkMove(ROWS, 'gone', 'a')).toEqual({ ok: false, quiet: true });
  });

  test('into its own subtree says why', () => {
    const check = checkMove(ROWS, 'a', 'a1x');
    expect(check.ok).toBe(false);
    expect(check.ok === false && !check.quiet ? check.reason : '').toContain(
      'can’t move under a node inside itself',
    );
  });

  test('across projects says why', () => {
    const check = checkMove(ROWS, 'b', 'c');
    expect(check.ok === false && !check.quiet ? check.reason : '').toContain(
      'can’t move between projects',
    );
    expect(checkMove(ROWS, 'b', 'root2').ok).toBe(false);
  });

  test('a project root never moves', () => {
    const check = checkMove(ROWS, 'root', 'b');
    expect(check.ok === false && !check.quiet ? check.reason : '').toContain('root');
  });
});

describe('outline, moveTargets and searchOutline', () => {
  test('reading order with depth', () => {
    expect(outline(ROWS).map((o) => `${o.row.id}:${o.depth}`)).toEqual([
      'root:0',
      'a:1',
      'a1:2',
      'a1x:3',
      'a2:2',
      'b:1',
      'root2:0',
      'c:1',
    ]);
    expect(projectOutline(ROWS, 'P-blog').map((o) => o.row.id)).toEqual(['root2', 'c']);
  });

  test('Move to… lists the project outside the node’s own subtree', () => {
    expect(moveTargets(ROWS, 'a1').map((o) => o.row.id)).toEqual(['root', 'a', 'a2', 'b']);
    expect(moveTargets(ROWS, 'c').map((o) => o.row.id)).toEqual(['root2']);
    expect(moveTargets(ROWS, 'root')).toEqual([]);
  });

  test('search keeps matching titles, case-insensitive', () => {
    const list = outline([
      row('r', { role: 'project', project: 'P', title: 'Shop' }),
      row('x', { parent: 'r', project: 'P', title: 'Import CSV' }),
      row('y', { parent: 'r', project: 'P', title: 'Export JSON' }),
    ]);
    expect(searchOutline(list, 'port').map((o) => o.row.id)).toEqual(['x', 'y']);
    expect(searchOutline(list, 'CSV').map((o) => o.row.id)).toEqual(['x']);
    expect(searchOutline(list, '  ')).toHaveLength(3);
  });
});

describe('typeAheadMatch (T426)', () => {
  const repos = [
    { text: 'No repository' },
    { text: 'ledger' },
    { text: 'ledger-lite' },
    { text: 'web' },
  ];
  test('the first that starts with what was typed, else the first that contains it', () => {
    expect(typeAheadMatch(repos, 'l')?.text).toBe('ledger');
    expect(typeAheadMatch(repos, 'LEDGER-')?.text).toBe('ledger-lite');
    expect(typeAheadMatch(repos, 'lite')?.text).toBe('ledger-lite');
    expect(typeAheadMatch(repos, 'zz')).toBeUndefined();
    expect(typeAheadMatch(repos, ' ')).toBeUndefined();
  });

  test('one letter again and again cycles through the options starting with it', () => {
    expect(typeAheadMatch(repos, 'll')?.text).toBe('ledger-lite');
    expect(typeAheadMatch(repos, 'lll')?.text).toBe('ledger');
    expect(typeAheadMatch(repos, 'ww')?.text).toBe('web');
  });
});

describe('pickHighlight (T435)', () => {
  const parents = [
    { value: '', text: 'Top level of Shop', pinned: true },
    { value: 'a', text: 'Add CSV import' },
    { value: 'b', text: 'Show sale prices' },
    { value: 'c', text: 'Sale badge', disabled: true },
    { value: 'd', text: 'web: show the sale badge' },
  ];
  test('no query: the current value, else the first pickable', () => {
    expect(pickHighlight(parents, '', '')).toBe('');
    expect(pickHighlight(parents, '  ', 'b')).toBe('b');
    expect(pickHighlight(parents, '', 'c')).toBe('');
    expect(pickHighlight(parents, '', 'gone')).toBe('');
  });
  test('typing: the first match that is not pinned, never the current value it kept', () => {
    // Audit r6 #7: "sale" and Enter kept Top level.
    expect(pickHighlight(parents, 'sale', '')).toBe('b');
    expect(pickHighlight(parents, 'SALE B', '')).toBe('d');
    expect(pickHighlight(parents, 'csv', 'b')).toBe('a');
  });
  test('a pinned option whose own text matches comes first; no match keeps the first', () => {
    expect(pickHighlight(parents, 'top', 'a')).toBe('');
    expect(pickHighlight(parents, 'shop', 'a')).toBe('');
    expect(pickHighlight(parents, 'zzz', 'a')).toBe('');
    const repos = [
      { value: '', text: 'No repository', pinned: true },
      { value: 'docs-site', text: 'docs-site' },
    ];
    expect(pickHighlight(repos, 'doc', '')).toBe('docs-site');
    expect(pickHighlight(repos, 'no', 'docs-site')).toBe('');
  });
});

describe('splitRepos', () => {
  test('the project’s repos first, each group by name', () => {
    const repos = [{ name: 'web' }, { name: 'api' }, { name: 'docs' }, { name: 'cli' }];
    expect(splitRepos(repos, ['web', 'api'])).toEqual({
      inProject: [{ name: 'api' }, { name: 'web' }],
      others: [{ name: 'cli' }, { name: 'docs' }],
    });
    expect(splitRepos(repos, undefined).inProject).toEqual([]);
  });
});

describe('newNodeDefaults', () => {
  const base = { rows: ROWS, projects: PROJECTS, selected: undefined, filter: undefined };

  test('a + on a row: under that node, project implied', () => {
    expect(newNodeDefaults({ ...base, preset: { parent: 'a1' } })).toEqual({
      project: 'P-shop',
      implied: true,
      parent: 'a1',
    });
  });

  test('a + on a project row, or its root: the project’s top level', () => {
    expect(newNodeDefaults({ ...base, preset: { project: 'P-blog' } })).toEqual({
      project: 'P-blog',
      implied: true,
      parent: '',
    });
    expect(newNodeDefaults({ ...base, preset: { parent: 'root2' } })).toEqual({
      project: 'P-blog',
      implied: true,
      parent: '',
    });
  });

  test('T353: the open node is the parent, even with a filter on another project', () => {
    expect(newNodeDefaults({ ...base, selected: 'b', filter: 'P-blog' })).toEqual({
      project: 'P-shop',
      implied: true,
      parent: 'b',
    });
  });

  test('nothing open: the filter, then the only project', () => {
    expect(newNodeDefaults({ ...base, filter: 'P-blog' })).toEqual({
      project: 'P-blog',
      implied: true,
      parent: '',
    });
    expect(
      newNodeDefaults({ ...base, rows: ROWS.slice(0, 6), projects: PROJECTS.slice(0, 1) }),
    ).toEqual({ project: 'P-shop', implied: true, parent: '' });
  });

  test('several projects and nothing to go on: the last used, else the first, and ask', () => {
    expect(newNodeDefaults({ ...base, lastUsed: 'P-blog' })).toEqual({
      project: 'P-blog',
      implied: false,
      parent: '',
    });
    expect(newNodeDefaults({ ...base, lastUsed: 'P-gone' })).toEqual({
      project: 'P-shop',
      implied: false,
      parent: '',
    });
  });

  test('no projects: nothing to file into', () => {
    expect(newNodeDefaults({ ...base, rows: [], projects: [] })).toEqual({
      project: undefined,
      implied: false,
      parent: '',
    });
  });

  test('a stale open node or filter falls through', () => {
    expect(
      newNodeDefaults({ ...base, selected: 'gone', filter: 'P-gone', lastUsed: 'P-blog' }),
    ).toEqual({ project: 'P-blog', implied: false, parent: '' });
  });
});

describe('the legend', () => {
  test('every status is listed once, and its row reads as that status', () => {
    expect(new Set(LEGEND_ORDER).size).toBe(15);
    for (const key of LEGEND_ORDER) {
      if (key === 'replied') continue;
      expect(nodeStatus(legendRow(key)).key).toBe(key);
    }
  });

  test('T436: "Replied" is listed after Done, and its row reads as a conversation that answered', () => {
    expect(LEGEND_ORDER.indexOf('replied')).toBe(LEGEND_ORDER.indexOf('done') + 1);
    const replied = nodeStatus(legendRow('replied'));
    expect(replied.label).toBe('Replied');
    expect(replied.tone).toBe('green');
    // The dot the rail draws for a project's conversation that finished its turn.
    expect(streamDot(legendRow('replied'))).toBe(
      streamDot({ agent_status: 'done', human_status: 'open', role: 'conversation', project: 'P' }),
    );
    expect(LEGEND_NOTE.replied).toContain('conversation');
  });
});

describe('T424: the overlap mark', () => {
  // a1x and a2 (both in Shop, under a) change src/ledger.ts; a2 and c (Blog) change api.ts.
  const rows = [
    ...ROWS.map((r) =>
      r.id === 'a1x'
        ? { ...r, title: 'Add CSV import' }
        : r.id === 'a2'
          ? { ...r, title: 'Fix rounding in totals' }
          : r,
    ),
  ];
  const one = [{ nodes: ['a1x', 'a2'] as [string, string], files: ['src/ledger.ts'] }];
  const two = [...one, { nodes: ['c', 'a2'] as [string, string], files: ['api.ts', 'b.ts'] }];

  test('the files in words', () => {
    expect(filesText(['src/ledger.ts'])).toBe('src/ledger.ts');
    expect(filesText(['a.ts', 'b.ts'])).toBe('a.ts and b.ts');
    expect(filesText(['a.ts', 'b.ts', 'c.ts'])).toBe('a.ts and 2 more files');
    expect(filesText([])).toBe('the same files');
  });

  test('its own overlap names the other node and the file, and leads there', () => {
    expect(overlapMark('a1x', one, rows, false)).toEqual({
      kind: 'own',
      targets: [
        {
          id: 'a2',
          title: 'Fix rounding in totals',
          files: 'src/ledger.ts',
          line: 'Overlaps Fix rounding in totals on src/ledger.ts',
        },
      ],
      text: 'Overlaps Fix rounding in totals on src/ledger.ts',
    });
    const both = overlapMark('a2', two, rows, false);
    expect(both?.targets.map((t) => t.id)).toEqual(['a1x', 'c']);
    expect(both?.text).toBe(
      'Overlaps Add CSV import on src/ledger.ts\nOverlaps c on api.ts and b.ts',
    );
  });

  test('an open parent or project shows none; folded, it speaks for the nodes inside', () => {
    expect(overlapMark('a', one, rows, false)).toBeUndefined();
    expect(overlapMark('root', one, rows, false)).toBeUndefined();
    expect(overlapMark('b', one, rows, true)).toBeUndefined();
    const folded = overlapMark('a1', one, rows, true);
    expect(folded).toEqual({
      kind: 'inside',
      targets: [
        {
          id: 'a1x',
          title: 'Add CSV import',
          files: 'src/ledger.ts',
          line: 'Add CSV import overlaps Fix rounding in totals on src/ledger.ts',
        },
      ],
      text: 'Add CSV import overlaps Fix rounding in totals on src/ledger.ts',
    });
    // Both sides inside: one line for the pair, both nodes to open.
    const root = overlapMark('root', one, rows, true);
    expect(root?.targets.map((t) => t.id)).toEqual(['a1x', 'a2']);
    expect(root?.text).toBe('Add CSV import overlaps Fix rounding in totals on src/ledger.ts');
    // Blog folded: its node c overlaps a Shop node.
    expect(overlapMark('root2', two, rows, true)?.text).toBe(
      'c overlaps Fix rounding in totals on api.ts and b.ts',
    );
  });

  test('a node the cockpit no longer knows reads "another node"; no overlaps, no mark', () => {
    expect(
      overlapMark('a1x', [{ nodes: ['a1x', 'gone'], files: ['x.ts'] }], rows, false)?.text,
    ).toBe('Overlaps another node on x.ts');
    expect(overlapMark('a1x', [], rows, false)).toBeUndefined();
  });
});
