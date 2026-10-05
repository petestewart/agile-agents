/** T499: a selection quoted into an answer or the composer. */

import { describe, expect, test } from 'bun:test';
import { quoteLines, tidySelection, withQuote } from './quote';

describe('quoting a selection', () => {
  test('every line is prefixed, then a blank line to write under', () => {
    expect(quoteLines('comma or semicolon?')).toBe('> comma or semicolon?\n\n');
    expect(quoteLines('first line\nsecond line')).toBe('> first line\n> second line\n\n');
  });

  test('a paragraph break stays as a bare ">"; the blank lines around it go', () => {
    expect(quoteLines('\n\nOne.\n\n\n\nTwo.\n\n')).toBe('> One.\n>\n> Two.\n\n');
  });

  test('Windows line ends, non-breaking and trailing spaces are made plain', () => {
    expect(tidySelection('a b  \r\nc\rd')).toBe('a b\nc\nd');
  });

  test('nothing selected, or only space: nothing to quote', () => {
    expect(quoteLines('')).toBe('');
    expect(quoteLines(' \n \n')).toBe('');
    expect(withQuote('my draft', '  ')).toBe('my draft');
  });

  test('into an empty box it is the quote alone; after text, a blank line comes first', () => {
    expect(withQuote('', 'quote every field?')).toBe('> quote every field?\n\n');
    expect(withQuote('   ', 'x')).toBe('> x\n\n');
    expect(withQuote('I think so.\n', 'quote every field?')).toBe(
      'I think so.\n\n> quote every field?\n\n',
    );
    // A second quote follows the first one's blank line, not a third.
    expect(withQuote(withQuote('', 'one'), 'two')).toBe('> one\n\n> two\n\n');
  });

  test('a quote that would pass the cap is cut short with "…"; no room keeps the draft', () => {
    const long = 'word '.repeat(100).trim();
    const out = withQuote('', long, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.startsWith('> word word')).toBe(true);
    expect(out.endsWith('…\n\n')).toBe(true);
    const draft = 'x'.repeat(58);
    expect(withQuote(draft, 'anything at all', 60)).toBe(draft);
  });
});
