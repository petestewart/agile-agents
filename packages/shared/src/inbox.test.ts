import { describe, expect, test } from 'bun:test';
import { ulid } from './ids';
import {
  INBOX_CONTEXT_MAX_CHARS,
  INBOX_ITEM_KINDS,
  type InboxItem,
  InboxItemSchema,
  inboxContext,
  validateInboxItem,
} from './inbox';

function item(overrides: Partial<InboxItem> = {}): unknown {
  return {
    kind: 'question',
    id: `Q-${ulid()}`,
    stream: ulid(),
    stream_path: ['ledger-lite', 'import CSV'],
    ts: new Date().toISOString(),
    context: 'which wins, the spec or the ticket?',
    ...overrides,
  };
}

describe('InboxItemSchema', () => {
  test('the four §3.1 kinds and nothing else', () => {
    expect([...INBOX_ITEM_KINDS]).toEqual(['question', 'gate', 'blocked', 'done']);
    expect(InboxItemSchema.safeParse(item({ kind: 'approve_plan' as never })).success).toBe(false);
  });

  test('accepts a minimal item and is strict', () => {
    expect(validateInboxItem(item()).kind).toBe('question');
    expect(() => validateInboxItem({ ...(item() as object), urgency: 'high' })).toThrow(
      /invalid InboxItem/,
    );
  });

  test('stream must be a ULID and stream_path must not be empty', () => {
    expect(InboxItemSchema.safeParse(item({ stream: 'TKT-0231' })).success).toBe(false);
    expect(InboxItemSchema.safeParse(item({ stream_path: [] })).success).toBe(false);
  });

  test('context is one line, capped at the §3.2 budget', () => {
    expect(InboxItemSchema.safeParse(item({ context: 'x'.repeat(201) })).success).toBe(false);
    expect(inboxContext('a\n  long   question\n')).toBe('a long question');
    const capped = inboxContext('x'.repeat(500));
    expect(capped.length).toBe(INBOX_CONTEXT_MAX_CHARS);
    expect(capped.endsWith('…')).toBe(true);
  });

  // T136 (QA rough edge 4): the cut lands between words, not inside one.
  test('context is elided at a word boundary', () => {
    const cut = inboxContext(`${'dialect '.repeat(40)}end`);
    expect(cut.length).toBeLessThanOrEqual(INBOX_CONTEXT_MAX_CHARS);
    expect(cut).toMatch(/dialect…$/);
    expect(cut).not.toMatch(/dial…$|diale…$|di…$/);
    // A single word longer than the budget still gets a hard cut: there is
    // no boundary to find.
    expect(inboxContext('y'.repeat(400))).toBe(`${'y'.repeat(INBOX_CONTEXT_MAX_CHARS - 1)}…`);
  });
});
