/**
 * Renders Markdown as prose (T049 defects 6 and 7): the EM's chat replies
 * (`ChatPanel`/`ChatWindow`) and the Brief pane's `oracle/product.md`.
 *
 * The HTML comes from `lib/markdown.ts`, which escapes every character of
 * the source before it emits any markup and never lets source text become a
 * tag, an attribute or a URL — see that file's "Safety" note. This component
 * is the one place the result is mounted, so there is exactly one
 * `dangerouslySetInnerHTML` in the app to audit.
 *
 * T338: ids the cockpit knows read as titles, and a click on one opens
 * that node's page; bare http(s) URLs open in a new tab.
 */

import { type MouseEvent, useLayoutEffect, useMemo, useRef } from 'react';
import { useOptionalFeed } from '../lib/feed-context';
import { renderMarkdown } from '../lib/markdown';
import { type Names, namesOf, tokenize } from '../lib/names';
import { useOptionalShell } from '../lib/shell';
import { findPassage } from '../lib/threads';

/**
 * T503 (D64, design/chat-threads.md §3a): a passage a thread is anchored
 * to, highlighted in the rendered text (a soft tint, its count after it,
 * amber when the thread waits on you). Found by its quote, nearest `near`
 * (0–1: where it starts in the source); not found, nothing is drawn.
 */
export interface PassageMark {
  id: string;
  quote: string;
  near?: number;
  count: number;
  amber?: boolean;
  /** What hovering names: its thread. */
  title: string;
}

/** Puts back the text a previous pass wrapped. */
function clearMarks(root: HTMLElement): void {
  for (const el of [...root.querySelectorAll('[data-anchor-ui]')]) {
    if (el.tagName === 'MARK') el.replaceWith(...el.childNodes);
    else el.remove();
  }
  root.normalize();
}

/** Wraps `mark`'s passage in `<mark>`s (one per text node it crosses), its count after the last. */
function drawMark(root: HTMLElement, mark: PassageMark): void {
  const nodes: { node: Text; start: number }[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }
  const span = findPassage(
    text,
    mark.quote,
    mark.near !== undefined ? Math.round(mark.near * text.length) : undefined,
  );
  if (span === undefined) return;
  let last: HTMLElement | undefined;
  for (const { node, start } of nodes) {
    const end = start + node.data.length;
    if (end <= span.start || start >= span.end) continue;
    let target = node;
    const from = Math.max(0, span.start - start);
    if (from > 0) target = target.splitText(from);
    const to = Math.min(target.data.length, span.end - Math.max(start, span.start));
    if (to < target.data.length) target.splitText(to);
    const el = document.createElement('mark');
    el.className = 'cr-anchor';
    el.setAttribute('data-anchor-ui', '');
    el.setAttribute('data-thread-anchor', mark.id);
    el.setAttribute('data-testid', 'thread-anchor');
    if (mark.amber) el.setAttribute('data-tone', 'amber');
    el.title = mark.title;
    target.replaceWith(el);
    el.append(target);
    last = el;
  }
  if (last === undefined) return;
  // The count is drawn by CSS from an attribute: never text a selection or a later quote reads.
  const count = document.createElement('span');
  count.className = 'cr-anchor-count';
  count.setAttribute('data-anchor-ui', '');
  count.setAttribute('data-thread-anchor', mark.id);
  count.setAttribute('data-testid', 'thread-anchor-count');
  count.setAttribute('data-count', String(mark.count));
  if (mark.amber) count.setAttribute('data-tone', 'amber');
  count.title = mark.title;
  last.after(count);
}

/** The cockpit's names, and what opening a node does, when rendered inside the shell. */
function useNames(): { names: Names; open?: (id: string) => void } {
  const cockpit = useOptionalFeed()?.cockpit;
  const shell = useOptionalShell();
  const names = useMemo(() => namesOf(cockpit), [cockpit]);
  return shell ? { names, open: shell.select } : { names };
}

function openRef(e: MouseEvent, open: ((id: string) => void) | undefined): void {
  const target = e.target as Element | null;
  const a = target?.closest?.('a[data-node]');
  const node = a?.getAttribute('data-node');
  if (!node || !open) return;
  e.preventDefault();
  open(node);
}

export function Markdown({
  text,
  className,
  testId,
  marks,
  onMark,
}: {
  text: string;
  className?: string;
  testId?: string;
  /** T503: passages threads are anchored to, highlighted; a click on one is `onMark(id)`. */
  marks?: readonly PassageMark[];
  onMark?: (id: string) => void;
}): JSX.Element {
  const { names, open } = useNames();
  const html = useMemo(() => renderMarkdown(text, names), [text, names]);
  const ref = useRef<HTMLDivElement>(null);
  const drawn = JSON.stringify(marks ?? []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `drawn` is `marks` by value; `html` re-set the text the marks wrap.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    clearMarks(root);
    for (const mark of marks ?? []) drawMark(root, mark);
  }, [html, drawn]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegates clicks from the anchors inside, which are keyboard-reachable themselves.
    <div
      ref={ref}
      className={className ? `cr-md ${className}` : 'cr-md'}
      data-testid={testId}
      onClick={(e) => {
        const thread = (e.target as Element | null)
          ?.closest?.('[data-thread-anchor]')
          ?.getAttribute('data-thread-anchor');
        if (thread && onMark) {
          e.preventDefault();
          onMark(thread);
          return;
        }
        openRef(e, open);
      }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the only HTML here is `renderMarkdown`'s own fixed tags over fully escaped source — that function exists precisely so this is safe, and it is unit-tested against injection.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** T338: one plain line (a delivery result, a scope) with its URLs and known ids as links. */
export function Linked({ text }: { text: string }): JSX.Element {
  const { names, open } = useNames();
  return (
    <>
      {tokenize(text, names).map((t, i) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional and never reordered.
        if (t.kind === 'text') return <span key={i}>{t.text}</span>;
        if (t.kind === 'url')
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional and never reordered.
            <a key={i} href={t.url} target="_blank" rel="noopener noreferrer">
              {t.url}
            </a>
          );
        return (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional and never reordered.
            key={i}
            href={`#${t.id}`}
            className="cr-ref"
            data-node={t.ref.node}
            title={t.id}
            onClick={(e) => openRef(e, open)}
          >
            {t.ref.title}
          </a>
        );
      })}
    </>
  );
}
