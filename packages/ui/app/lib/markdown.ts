/**
 * A small, safe Markdown renderer (T049 defects 6 and 7).
 *
 * The EM's replies and `oracle/product.md` are Markdown, and the control
 * room was printing both as raw text — `**bold**`, `-` bullets and fenced
 * code all read as noise (screenshots 1 and 3 on the ticket). This turns the
 * subset those two surfaces actually use into HTML: headings, paragraphs,
 * bold/italic, inline code, fenced code, bullet and numbered lists, and hard
 * line breaks.
 *
 * Why a renderer here rather than a dependency: the workspace has no
 * Markdown library and CLAUDE.md's "no new codebase conventions without
 * explicit approval" plus the ticket's own "no new dependency" make adding
 * one the wrong call for ~150 lines of formatting.
 *
 * **Safety.** Every character of the source is HTML-escaped *first*
 * (`escapeHtml`), before any markup is produced, and the only HTML this
 * module ever emits is its own fixed tag strings. So a reply containing
 * `<img src=x onerror=alert(1)>` renders as that literal text, not as an
 * element; there is no path by which source text becomes a tag, an
 * attribute, or a URL. Markdown links are deliberately NOT supported for
 * the same reason — a `[text](javascript:…)` target would be the one place
 * source text reached an attribute.
 *
 * T338: two link kinds are, both made here, never from Markdown syntax: a
 * bare `http://`/`https://` URL (the only scheme the pattern in `names.ts`
 * matches; it stops at quotes and angle brackets, so the escaped text it
 * puts in `href` cannot leave the attribute), and a node/project/contract
 * id the cockpit knows, shown as its title (escaped) with the id kept only
 * as `data-node`/`title`.
 */

import { NO_NAMES, type Names, type Token, tokenize } from './names';

/**
 * The placeholder character inline code is parked behind while the bold and
 * italic passes run. A Unicode private-use code point rather than a control
 * character (biome's `noControlCharactersInRegex`), and `renderMarkdown`
 * strips it from the source first so a document cannot forge a placeholder.
 */
const SENTINEL = '\ue000';

/** The five characters that can end an HTML text node or attribute. Escaped before anything else happens. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Inline spans, applied to text that is ALREADY escaped: inline code first
 * (so a backtick span's contents are never re-read for `*`/`_`), then bold,
 * then italic. `&#39;`/`&quot;` entities left by `escapeHtml` contain no
 * `*`/`_`/`` ` ``, so they cannot be corrupted by these passes.
 */
function renderInline(escaped: string, names: Names): string {
  const code: string[] = [];
  const links: string[] = [];
  const link = (html: string) => {
    links.push(html);
    return `${SENTINEL}LINK${links.length - 1}${SENTINEL}`;
  };
  // `` `code` `` — stashed behind a placeholder built from `SENTINEL`, which
  // `renderMarkdown` has already stripped from the source, so no input can
  // forge one. A span that is exactly a known id reads as its title.
  // T393: a span opened by N backticks closes at the next run of exactly N, so
  // `` a `b` `` is code holding backticks; one space inside each fence is padding.
  let out = escaped.replace(/(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, (_m, _fence, span: string) => {
    const body = /^ .*[^ ].* $/.test(span) ? span.slice(1, -1) : span;
    const only = tokenize(body, names);
    if (only.length === 1 && only[0]?.kind === 'ref') return link(linkHtml(only[0]));
    code.push(body);
    return `${SENTINEL}CODE${code.length - 1}${SENTINEL}`;
  });
  // T338: URLs and known ids, stashed too so the emphasis passes never reach an attribute.
  out = tokenize(out, names)
    .map((t) => (t.kind === 'text' ? t.text : link(linkHtml(t))))
    .join('');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^\w_])_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(
    new RegExp(`${SENTINEL}CODE(\\d+)${SENTINEL}`, 'g'),
    (_m, i: string) => `<code>${code[Number(i)]}</code>`,
  );
  out = out.replace(
    new RegExp(`${SENTINEL}LINK(\\d+)${SENTINEL}`, 'g'),
    (_m, i: string) => links[Number(i)] as string,
  );
  return out;
}

/** A URL or id token of already-escaped text as its anchor. */
function linkHtml(t: Exclude<Token, { kind: 'text' }>): string {
  if (t.kind === 'url') {
    return `<a href="${t.url}" target="_blank" rel="noopener noreferrer">${t.url}</a>`;
  }
  return `<a href="#${escapeHtml(t.id)}" class="cr-ref" data-node="${escapeHtml(t.ref.node)}" title="${escapeHtml(t.id)}">${escapeHtml(t.ref.title)}</a>`;
}

/** `- item` / `* item` / `+ item`. */
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
/** `1. item` / `1) item`. */
const ORDERED = /^\s{0,3}(\d+)[.)]\s+(.*)$/;
/** T393: an indented line under a list item continues that item. */
const CONTINUATION = /^\s{2,}\S/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s{0,3}```(.*)$/;

/**
 * Markdown -> HTML. The result is safe to hand to `dangerouslySetInnerHTML`
 * (see this file's header for why), and is the only thing this module
 * returns.
 */
export function renderMarkdown(source: string, names: Names = NO_NAMES): string {
  const lines = source.replaceAll(SENTINEL, '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | undefined;

  function flushParagraph(): void {
    if (paragraph.length === 0) return;
    // A single newline inside a paragraph is a visible line break — the EM
    // writes its replies that way and collapsing them reads as a wall.
    out.push(`<p>${paragraph.map((l) => renderInline(escapeHtml(l), names)).join('<br>')}</p>`);
    paragraph = [];
  }

  function flushList(): void {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    // A list interrupted by a paragraph or a fence keeps counting (`start` is digits only).
    const open = list.ordered && list.start !== 1 ? `<ol start="${list.start}">` : `<${tag}>`;
    out.push(`${open}${list.items.map((i) => `<li>${i}</li>`).join('')}</${tag}>`);
    list = undefined;
  }

  function flushAll(): void {
    flushParagraph();
    flushList();
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    const fence = FENCE.exec(line);
    if (fence) {
      flushAll();
      const body: string[] = [];
      i++;
      for (; i < lines.length && !FENCE.test(lines[i] as string); i++) {
        body.push(lines[i] as string);
      }
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      const level = (heading[1] as string).length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2] as string), names)}</h${level}>`);
      continue;
    }

    const ordered = ORDERED.exec(line);
    const bullet = ordered ? null : BULLET.exec(line);
    if (ordered || bullet) {
      flushParagraph();
      const wantOrdered = ordered !== null;
      if (list && list.ordered !== wantOrdered) flushList();
      if (!list) list = { ordered: wantOrdered, start: Number(ordered?.[1] ?? 1), items: [] };
      const text = (ordered ? ordered[2] : (bullet as RegExpExecArray)[1]) as string;
      list.items.push(renderInline(escapeHtml(text), names));
      continue;
    }

    // T393: `1. item` then an indented line: the line is the item's, not a new paragraph.
    if (list && CONTINUATION.test(line)) {
      const last = list.items.length - 1;
      list.items[last] = `${list.items[last]}<br>${renderInline(escapeHtml(line.trim()), names)}`;
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushAll();
  return out.join('');
}
