/** T338: ids read as titles, URLs as links, at render time. */

import { describe, expect, test } from 'bun:test';
import { renderMarkdown } from './markdown';
import { namesOf, tokenize } from './names';

const NODE = '01J8Z3K4M5N6P7Q8R9S0T1V2W3';
const ROOT = '01J8Z3K4M5N6P7Q8R9S0T1V2W4';
const PROJECT = `P-${ROOT}`;
const CONTRACT = `C-${NODE}`;
const names = namesOf({
  streams: [
    {
      id: NODE,
      title: 'api: add <salePrice>',
      role: 'work',
      agent_status: 'idle',
      human_status: 'open',
    },
    {
      id: ROOT,
      title: 'Show sale prices',
      role: 'coordinating',
      agent_status: 'idle',
      human_status: 'open',
    },
  ],
  projects: [{ id: PROJECT, name: 'Shop', root: ROOT }],
  contracts: [{ id: CONTRACT, title: 'GET /price/:id', node: ROOT }],
});

describe('tokenize', () => {
  test('known node, project and contract ids become refs; unknown ids stay text', () => {
    const other = '01J8Z3K4M5N6P7Q8R9S0T1V2W5';
    const tokens = tokenize(`${NODE} in ${PROJECT} relies on ${CONTRACT}; ${other}`, names);
    expect(
      tokens.filter((t) => t.kind === 'ref').map((t) => t.kind === 'ref' && t.ref.title),
    ).toEqual(['api: add <salePrice>', 'Shop', 'GET /price/:id']);
    expect(tokens.at(-1)).toEqual({ kind: 'text', text: `; ${other}` });
  });

  test('an id inside a path or a file name is left alone', () => {
    expect(tokenize(`plans/${NODE}.yaml`, names)).toEqual([
      { kind: 'text', text: `plans/${NODE}.yaml` },
    ]);
  });

  test('http(s) URLs only, without trailing punctuation', () => {
    const tokens = tokenize(
      'opened PR #2 into main: https://github.com/o/r/pull/2. see (http://x.io/a) javascript:alert(1)',
      names,
    );
    expect(tokens.filter((t) => t.kind === 'url')).toEqual([
      { kind: 'url', url: 'https://github.com/o/r/pull/2' },
      { kind: 'url', url: 'http://x.io/a' },
    ]);
  });
});

describe('renderMarkdown with names (T338)', () => {
  test('an id renders as its escaped title, linked to its node', () => {
    const html = renderMarkdown(`waits on ${NODE}`, names);
    expect(html).toBe(
      `<p>waits on <a href="#${NODE}" class="cr-ref" data-node="${NODE}" title="${NODE}">api: add &lt;salePrice&gt;</a></p>`,
    );
  });

  test('a contract links to its owning node; an id alone in backticks is named too', () => {
    expect(renderMarkdown(`\`${CONTRACT}\``, names)).toContain(`data-node="${ROOT}"`);
    expect(renderMarkdown(`\`${CONTRACT}\``, names)).toContain('>GET /price/:id</a>');
  });

  test('a URL is a new-tab link with noopener noreferrer, and emphasis never reaches its href', () => {
    const html = renderMarkdown('see https://x.io/a_b_c and _this_');
    expect(html).toBe(
      '<p>see <a href="https://x.io/a_b_c" target="_blank" rel="noopener noreferrer">https://x.io/a_b_c</a> and <em>this</em></p>',
    );
  });

  test('a quote ends the URL, so it cannot break out of href', () => {
    const html = renderMarkdown('https://x.io/"onmouseover="alert(1)');
    expect(html).toContain('href="https://x.io/"');
    expect(html).not.toContain('onmouseover="');
  });

  test('without names, ids stay as written', () => {
    expect(renderMarkdown(`waits on ${NODE}`)).toBe(`<p>waits on ${NODE}</p>`);
  });
});
