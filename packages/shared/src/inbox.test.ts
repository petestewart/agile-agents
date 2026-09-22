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
  test('the §3.1 kinds and nothing else', () => {
    expect([...INBOX_ITEM_KINDS]).toEqual(['question', 'gate', 'rule_accept', 'blocked', 'done']);
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
    expect(InboxItemSchema.safeParse(item({ stream: undefined })).success).toBe(false);
  });

  // T140: a global proposed rule belongs to no stream and still needs
  // deciding, so `rule_accept` is the one kind that may carry neither.
  test('a rule_accept item may have no stream at all', () => {
    const streamless = InboxItemSchema.safeParse(
      item({ kind: 'rule_accept', id: `R-${ulid()}`, stream: undefined, stream_path: [] }),
    );
    expect(streamless.success).toBe(true);
  });

  test('context is one line, capped at the §3.2 budget', () => {
    expect(InboxItemSchema.safeParse(item({ context: 'x'.repeat(201) })).success).toBe(false);
    expect(inboxContext('a\n  long   question\n')).toBe('a long question');
    const capped = inboxContext('x'.repeat(500));
    expect(capped.length).toBe(INBOX_CONTEXT_MAX_CHARS);
    expect(capped.endsWith('…')).toBe(true);
  });
});
