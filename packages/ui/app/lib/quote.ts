/**
 * T499: Quote — text selected in a question card or a chat message, put in
 * an answer (or the composer) as a Markdown quote: every line prefixed with
 * `> `, then a blank line to write under. Pure, so the browser part
 * (`QuoteSelection` in `Chat.tsx`) only reads the selection and calls this.
 */

import { MESSAGE_BODY_MAX_CHARS } from '@agile-agents/shared';

/**
 * The selection as text worth quoting: Windows line ends and non-breaking
 * spaces made plain, trailing spaces gone, the blank lines around it dropped
 * and runs of blank lines inside it kept to one.
 */
export function tidySelection(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/** `> ` before every line (a blank line inside it is a bare `>`), then a blank line; empty for nothing. */
export function quoteLines(selection: string): string {
  const text = tidySelection(selection);
  if (text.trim() === '') return '';
  const lines = text.split('\n').map((line) => (line === '' ? '>' : `> ${line}`));
  return `${lines.join('\n')}\n\n`;
}

/**
 * `draft` with the quote added at its end (after a blank line when it has
 * text already). The quote is cut short with "…" when the whole would pass
 * `max` (a message's cap); with no room left for it, the draft is returned
 * as it was.
 */
export function withQuote(draft: string, selection: string, max = MESSAGE_BODY_MAX_CHARS): string {
  let text = tidySelection(selection);
  if (text.trim() === '') return draft;
  const lead = draft.trim() === '' ? '' : `${draft.trimEnd()}\n\n`;
  let quoted = quoteLines(text);
  while (lead.length + quoted.length > max) {
    const keep = text.length - (lead.length + quoted.length - max) - 1;
    if (keep <= 0) return draft;
    text = `${text.slice(0, keep).trimEnd()}…`;
    quoted = quoteLines(text);
  }
  return lead + quoted;
}
