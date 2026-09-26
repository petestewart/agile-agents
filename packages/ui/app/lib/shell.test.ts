/** T348 (D36 D2): the open node, view and project filter round-trip through the URL. */

import { describe, expect, test } from 'bun:test';
import { type ShellLocation, parseShellUrl, shellSearch } from './shell';

const NODE = '01J8Z3K4M5N6P7Q8R9S0T1V2W3';
const PROJECT = 'P-01J8Z3K4M5N6P7Q8R9S0T1V2W4';

describe('parseShellUrl', () => {
  test('no query is the inbox, all projects', () => {
    expect(parseShellUrl('')).toEqual({ view: 'inbox', node: undefined, project: undefined });
  });

  test('?node= opens that node, with the project filter', () => {
    expect(parseShellUrl(`?node=${NODE}&project=${PROJECT}`)).toEqual({
      view: 'stream',
      node: NODE,
      project: PROJECT,
    });
  });

  test('?view= keeps the T112 deep links', () => {
    expect(parseShellUrl('?view=settings').view).toBe('settings');
    expect(parseShellUrl('?view=rules&project=p').project).toBe('p');
  });

  test('a node wins over a view', () => {
    expect(parseShellUrl(`?view=rules&node=${NODE}`).view).toBe('stream');
  });

  test('unknown or empty values fall back to the inbox and "All"', () => {
    expect(parseShellUrl('?view=nope')).toEqual({
      view: 'inbox',
      node: undefined,
      project: undefined,
    });
    // `stream` needs an id: without one it is not a view a link may name.
    expect(parseShellUrl('?view=stream').view).toBe('inbox');
    expect(parseShellUrl('?node=&project=')).toEqual({
      view: 'inbox',
      node: undefined,
      project: undefined,
    });
  });
});

describe('shellSearch', () => {
  test('the plain inbox is no query at all', () => {
    expect(shellSearch({ view: 'inbox', node: undefined, project: undefined })).toBe('');
  });

  test('a node page, a view, and the filter', () => {
    expect(shellSearch({ view: 'stream', node: NODE, project: undefined })).toBe(`?node=${NODE}`);
    expect(shellSearch({ view: 'events', node: NODE, project: PROJECT })).toBe(
      `?view=events&project=${PROJECT}`,
    );
    expect(shellSearch({ view: 'inbox', node: undefined, project: PROJECT })).toBe(
      `?project=${PROJECT}`,
    );
  });

  test('the stream view without a node is the inbox', () => {
    expect(shellSearch({ view: 'stream', node: undefined, project: undefined })).toBe('');
  });

  test('odd characters are escaped and come back unchanged', () => {
    const odd: ShellLocation = { view: 'stream', node: 'a&b=c d', project: 'p/q?' };
    expect(parseShellUrl(shellSearch(odd))).toEqual(odd);
  });

  test('every location round-trips', () => {
    const cases: ShellLocation[] = [
      { view: 'inbox', node: undefined, project: undefined },
      { view: 'stream', node: NODE, project: PROJECT },
      { view: 'settings', node: undefined, project: undefined },
      { view: 'director', node: undefined, project: PROJECT },
    ];
    for (const c of cases) expect(parseShellUrl(shellSearch(c))).toEqual(c);
  });
});
