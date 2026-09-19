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
 * attribute, or a URL. Links are deliberately NOT supported for the same
 * reason — a `[text](javascript:…)` target would be the one place source
 * text reached an attribute.
 */

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
function renderInline(escaped: string): string {
  const code: string[] = [];
  // `` `code` `` — stashed behind a placeholder built from `SENTINEL`, which
  // `renderMarkdown` has already stripped from the source, so no input can
  // forge one.
  let out = escaped.replace(/`([^`]+)`/g, (_m, body: string) => {
    code.push(body);
    return `${SENTINEL}CODE${code.length - 1}${SENTINEL}`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^\w_])_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(
    new RegExp(`${SENTINEL}CODE(\\d+)${SENTINEL}`, 'g'),
    (_m, i: string) => `<code>${code[Number(i)]}</code>`,
  );
  return out;
}

/** `- item` / `* item` / `+ item`. */
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
/** `1. item` / `1) item`. */
const ORDERED = /^\s{0,3}\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s{0,3}```(.*)$/;

/**
 * Markdown -> HTML. The result is safe to hand to `dangerouslySetInnerHTML`
 * (see this file's header for why), and is the only thing this module
 * returns.
 */
export function renderMarkdown(source: string): string {
  const lines = source.replaceAll(SENTINEL, '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;

  function flushParagraph(): void {
    if (paragraph.length === 0) return;
    // A single newline inside a paragraph is a visible line break — the EM
    // writes its replies that way and collapsing them reads as a wall.
    out.push(`<p>${paragraph.map((l) => renderInline(escapeHtml(l))).join('<br>')}</p>`);
    paragraph = [];
  }

  function flushList(): void {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    out.push(`<${tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${tag}>`);
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
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2] as string))}</h${level}>`);
      continue;
    }

    const ordered = ORDERED.exec(line);
    const bullet = ordered ? null : BULLET.exec(line);
    if (ordered || bullet) {
      flushParagraph();
      const wantOrdered = ordered !== null;
      if (list && list.ordered !== wantOrdered) flushList();
      if (!list) list = { ordered: wantOrdered, items: [] };
      const text = (ordered ? ordered[1] : (bullet as RegExpExecArray)[1]) as string;
      list.items.push(renderInline(escapeHtml(text)));
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushAll();
  return out.join('');
}
