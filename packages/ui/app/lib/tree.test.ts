/** T365: the rail's pure helpers — New node's defaults and title, Move to…, Delete, the legend. */

import { describe, expect, test } from 'bun:test';
import type { CockpitProjectRow, CockpitStreamRow } from './feed-types';
import { nodeStatus } from './status';
import {
  LEGEND_ORDER,
  checkMove,
  deleteQuestion,
  legendRow,
  moveTargets,
  newNodeDefaults,
  outline,
  projectOutline,
  searchOutline,
  splitRepos,
  subtreeIds,
  titleFromGoal,
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

  test('a long line is cut at a word, with an ellipsis', () => {
    const goal =
      'Compare the pricing pages of three competitors and write up what each tier includes, what it costs and who it is for';
    const title = titleFromGoal(goal);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith('…')).toBe(true);
    expect(goal.startsWith(title.slice(0, -1))).toBe(true);
    expect(title.slice(0, -1).endsWith(' ')).toBe(false);
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
    expect(new Set(LEGEND_ORDER).size).toBe(12);
    for (const key of LEGEND_ORDER) expect(nodeStatus(legendRow(key)).key).toBe(key);
  });
});
