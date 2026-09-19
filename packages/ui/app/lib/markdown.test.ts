/**
 * T049 defects 6/7 — the safe Markdown renderer behind the EM chat and the
 * Brief pane. Plain `bun test`, no DOM and no native modules: the renderer
 * is a pure string function precisely so it can be tested this way.
 */

import { describe, expect, test } from 'bun:test';
import { escapeHtml, renderMarkdown } from './markdown';

describe('escapeHtml', () => {
  test('neutralises every character that can end a text node or an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('renderMarkdown', () => {
  test('two paragraphs render as two <p> elements', () => {
    expect(renderMarkdown('First para.\n\nSecond para.')).toBe(
      '<p>First para.</p><p>Second para.</p>',
    );
  });

  test('a single newline inside a paragraph is a hard line break', () => {
    expect(renderMarkdown('one\ntwo')).toBe('<p>one<br>two</p>');
  });

  test('headings render at their level', () => {
    expect(renderMarkdown('# Product\n\n### Non-goals')).toBe('<h1>Product</h1><h3>Non-goals</h3>');
  });

  test('bold, italic and inline code', () => {
    expect(renderMarkdown('**TKT-2001** is *done*, see `Ledger.transfer()`')).toBe(
      '<p><strong>TKT-2001</strong> is <em>done</em>, see <code>Ledger.transfer()</code></p>',
    );
  });

  test('bullet and numbered lists become <ul>/<ol> with one <li> per item', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
  });

  test('a fenced block is a <pre><code> with its contents left verbatim', () => {
    expect(renderMarkdown('```ts\nconst a = 1 < 2;\n```')).toBe(
      '<pre><code>const a = 1 &lt; 2;</code></pre>',
    );
  });

  test('markdown inside inline code is not re-interpreted', () => {
    expect(renderMarkdown('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  });

  test('HTML in the source is text, never markup — in prose, in code and in a list', () => {
    const html = renderMarkdown(
      '<img src=x onerror=alert(1)>\n\n- <script>alert(1)</script>\n\n```\n<b>x</b>\n```',
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  test('a link target never reaches an attribute — link syntax stays literal text', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('href');
    expect(html).toContain('[click](javascript:alert(1))');
  });

  test('an EM reply with a bold run, a list and two paragraphs renders as elements', () => {
    const html = renderMarkdown(
      'No open tickets.\n\n- **TKT-2001** — `Ledger.transfer()`\n- **TKT-2002** — `Ledger.reverse()`\n\nS-1 is ready for review.',
    );
    expect(html).toContain('<ul>');
    expect(html).toContain('<strong>TKT-2001</strong>');
    expect(html).toContain('<code>Ledger.transfer()</code>');
    expect((html.match(/<p>/g) ?? []).length).toBe(2);
  });

  test('empty source renders nothing', () => {
    expect(renderMarkdown('')).toBe('');
  });
});

describe('the inline-code placeholder', () => {
  test('cannot be forged: the sentinel is stripped from the source', () => {
    const html = renderMarkdown('CODE0 and `real`');
    expect(html).toBe('<p>CODE0 and <code>real</code></p>');
  });
});
