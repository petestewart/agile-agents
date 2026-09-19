/**
 * Renders Markdown as prose (T049 defects 6 and 7): the EM's chat replies
 * (`ChatPanel`/`ChatWindow`) and the Brief pane's `oracle/product.md`.
 *
 * The HTML comes from `lib/markdown.ts`, which escapes every character of
 * the source before it emits any markup and never lets source text become a
 * tag, an attribute or a URL — see that file's "Safety" note. This component
 * is the one place the result is mounted, so there is exactly one
 * `dangerouslySetInnerHTML` in the app to audit.
 */

import { renderMarkdown } from '../lib/markdown';

export function Markdown({
  text,
  className,
  testId,
}: { text: string; className?: string; testId?: string }): JSX.Element {
  return (
    <div
      className={className ? `cr-md ${className}` : 'cr-md'}
      data-testid={testId}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the only HTML here is `renderMarkdown`'s own fixed tags over fully escaped source — that function exists precisely so this is safe, and it is unit-tested against injection.
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}
