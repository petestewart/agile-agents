import { describe, expect, test } from 'bun:test';
import { ChatBatchSchema, ChatThreadSchema } from './chat-thread';
import { ulid } from './ids';
import { questionOfChatThread } from './stream';

describe('ChatThreadSchema (T503)', () => {
  const at = '2026-10-02T10:05:00.000Z';
  const thread = {
    id: at,
    stream: ulid(),
    anchor: { entry: '2026-10-02T10:02:00.000Z', start: 0, end: 4, quote: 'cent' },
    state: 'waiting_on_agent',
    replies: 1,
    entries: [at],
    last_at: at,
  };

  test('derived, strict, and its state is one of four', () => {
    expect(ChatThreadSchema.safeParse(thread).success).toBe(true);
    for (const state of ['open', 'waits_on_you', 'waiting_on_agent', 'resolved']) {
      expect(ChatThreadSchema.safeParse({ ...thread, state }).success).toBe(true);
    }
    expect(ChatThreadSchema.safeParse({ ...thread, state: 'archived' }).success).toBe(false);
    expect(ChatThreadSchema.safeParse({ ...thread, unread: 2 }).success).toBe(false);
    expect(ChatThreadSchema.safeParse({ ...thread, replies: -1 }).success).toBe(false);
    expect(ChatThreadSchema.safeParse({ ...thread, questions: ['Q-1'] }).success).toBe(false);
    expect(ChatThreadSchema.safeParse({ ...thread, questions: [`Q-${ulid()}`] }).success).toBe(true);
  });

  test('a batched turn links at least one thread', () => {
    expect(ChatBatchSchema.safeParse({ entries: [at], threads: [at] }).success).toBe(true);
    expect(ChatBatchSchema.safeParse({ entries: [at], threads: [] }).success).toBe(false);
    expect(ChatBatchSchema.safeParse({ entries: [], threads: [at] }).success).toBe(false);
  });

  test('a question’s thread id names its question', () => {
    const id = `Q-${ulid()}`;
    expect(questionOfChatThread(`questions/${id}`)).toBe(id);
    expect(questionOfChatThread(at)).toBeUndefined();
    expect(questionOfChatThread(undefined)).toBeUndefined();
  });
});
