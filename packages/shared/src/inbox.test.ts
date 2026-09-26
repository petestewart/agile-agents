import { describe, expect, test } from 'bun:test';
import { ulid } from './ids';
import {
  INBOX_CONTEXT_MAX_CHARS,
  INBOX_DETAIL_MAX_CHARS,
  INBOX_ITEM_KINDS,
  type InboxItem,
  InboxItemSchema,
  inboxContext,
  inboxDetail,
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
    expect([...INBOX_ITEM_KINDS]).toEqual([
      'question',
      'gate',
      'rule_accept',
      'rule_batch',
      'plan_approve',
      'plan_waiting',
      'proposal',
      'blocked',
      'done',
    ]);
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

  test('T361: only a question item carries options, one line each, six at most', () => {
    expect(validateInboxItem(item({ options: ['yes', 'no'] })).options).toEqual(['yes', 'no']);
    expect(InboxItemSchema.safeParse(item({ options: ['only one'] })).success).toBe(true);
    expect(InboxItemSchema.safeParse(item({ options: [] })).success).toBe(false);
    expect(
      InboxItemSchema.safeParse(item({ options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).success,
    ).toBe(false);
    expect(InboxItemSchema.safeParse(item({ options: ['x'.repeat(201)] })).success).toBe(false);
    const gate = item({ kind: 'gate', id: `HIL-${ulid()}`, options: ['approve'] });
    expect(() => validateInboxItem(gate)).toThrow(/only a question item carries options/);
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

  // T341: a cut inside a code span closes the span.
  test('context cut inside a code span closes it', () => {
    const cut = inboxContext(
      `${'word '.repeat(35)}\`{ "date": "YYYY-MM-DD", "amount": 1, "memo": "x" }\` end`,
    );
    expect(cut.length).toBeLessThanOrEqual(INBOX_CONTEXT_MAX_CHARS);
    expect(cut.endsWith('`…')).toBe(true);
    expect((cut.match(/`/g) ?? []).length % 2).toBe(0);
    expect(inboxContext(`\`${'y'.repeat(400)}`)).toBe(
      `\`${'y'.repeat(INBOX_CONTEXT_MAX_CHARS - 3)}\`…`,
    );
  });

  // T161: a clipped card must be readable in full.
  test('detail carries the full text only when the context clipped it', () => {
    expect(inboxDetail('a short question')).toBeUndefined();
    expect(inboxDetail('a\n  short\n  multi-line one')).toBeUndefined();
    const long = `${'which delimiter wins, '.repeat(15)}the end?`;
    expect(inboxDetail(long)).toBe(long);
    expect(inboxContext(long).length).toBeLessThanOrEqual(INBOX_CONTEXT_MAX_CHARS);
    const huge = inboxDetail('z '.repeat(5000)) ?? '';
    expect(huge.length).toBe(INBOX_DETAIL_MAX_CHARS);
    expect(InboxItemSchema.safeParse(item({ detail: long })).success).toBe(true);
    expect(
      InboxItemSchema.safeParse(item({ detail: 'x'.repeat(INBOX_DETAIL_MAX_CHARS + 1) })).success,
    ).toBe(false);
  });
});
