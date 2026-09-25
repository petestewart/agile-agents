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

import { type MouseEvent, useMemo } from 'react';
import { useOptionalFeed } from '../lib/feed-context';
import { renderMarkdown } from '../lib/markdown';
import { type Names, namesOf, tokenize } from '../lib/names';
import { useOptionalShell } from '../lib/shell';

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
}: { text: string; className?: string; testId?: string }): JSX.Element {
  const { names, open } = useNames();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegates clicks from the anchors inside, which are keyboard-reachable themselves.
    <div
      className={className ? `cr-md ${className}` : 'cr-md'}
      data-testid={testId}
      onClick={(e) => openRef(e, open)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the only HTML here is `renderMarkdown`'s own fixed tags over fully escaped source — that function exists precisely so this is safe, and it is unit-tested against injection.
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text, names) }}
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
