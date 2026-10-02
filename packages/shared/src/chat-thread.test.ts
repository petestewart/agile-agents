import { describe, expect, test } from 'bun:test';
import { ChatBatchSchema, ChatMoveSchema, ChatThreadSchema } from './chat-thread';
import { ulid, ulidTime } from './ids';
import { QuestionResolvedAsSchema } from './question';
import { QUIET_EVENT_TYPES, RoutedEventSchema } from './routed-event';
import { COMPACT_COMMANDS, compactCommandFor } from './session-defaults';
import {
  StreamArchiveThreadInputSchema,
  StreamCreateInputSchema,
  StreamMoveLineInputSchema,
  ThreadEntrySchema,
  ThreadOpSchema,
  chatThreadOpsOf,
  questionOfChatThread,
} from './stream';

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
    expect(ChatThreadSchema.safeParse({ ...thread, questions: [`Q-${ulid()}`] }).success).toBe(
      true,
    );
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

describe('thread changes (T504, D65)', () => {
  const t1 = '2026-10-02T10:01:00.000Z';
  const t2 = '2026-10-02T10:02:00.000Z';
  const rec = (ts: string, op: unknown) => ({ ts, by: 'human', kind: 'event', body: 'x', op });

  test('each change is strict, and only yours, on an event line in no thread', () => {
    expect(ThreadOpSchema.safeParse({ type: 'move', entry: t1, to: 'main' }).success).toBe(true);
    expect(ThreadOpSchema.safeParse({ type: 'move', entry: t1, to: t2 }).success).toBe(true);
    expect(ThreadOpSchema.safeParse({ type: 'move', entry: t1, to: 'side' }).success).toBe(false);
    expect(ThreadOpSchema.safeParse({ type: 'archive', thread: t1, forget: true }).success).toBe(
      true,
    );
    expect(ThreadOpSchema.safeParse({ type: 'archive', thread: t1, forget: false }).success).toBe(
      false,
    );
    expect(ThreadOpSchema.safeParse({ type: 'archive', thread: t1, why: 'x' }).success).toBe(false);
    expect(ThreadOpSchema.safeParse({ type: 'promote', thread: t1, node: ulid() }).success).toBe(
      true,
    );
    expect(ThreadOpSchema.safeParse({ type: 'compact', threads: [] }).success).toBe(false);
    expect(ThreadOpSchema.safeParse({ type: 'delete', thread: t1 }).success).toBe(false);

    const ok = rec(t2, { type: 'archive', thread: t1 });
    expect(ThreadEntrySchema.safeParse(ok).success).toBe(true);
    expect(ThreadEntrySchema.safeParse({ ...ok, by: `agent:${ulid()}` }).success).toBe(false);
    expect(ThreadEntrySchema.safeParse({ ...ok, kind: 'line' }).success).toBe(false);
    expect(ThreadEntrySchema.safeParse({ ...ok, thread: t1 }).success).toBe(false);
    expect(ThreadEntrySchema.safeParse({ ...ok, agent_only: true }).success).toBe(false);
  });

  test('read back in order: the latest move wins, a restore undoes an archive', () => {
    const ops = chatThreadOpsOf([
      rec('a', { type: 'move', entry: t2, to: t1 }),
      rec('b', { type: 'archive', thread: t1, forget: true }),
      rec('c', { type: 'move', entry: t2, to: 'main' }),
      rec('d', { type: 'promote', thread: t1, node: 'N' }),
    ] as never);
    expect(ops.moves.get(t2)).toEqual({ to: 'main', at: 'c' });
    expect(ops.archived.get(t1)).toEqual({ at: 'b', forget: true });
    expect(ops.promoted.get(t1)).toEqual({ node: 'N', at: 'd' });
    const restored = chatThreadOpsOf([
      rec('a', { type: 'archive', thread: t1 }),
      rec('b', { type: 'unarchive', thread: t1 }),
    ] as never);
    expect(restored.archived.size).toBe(0);
  });

  test('the routes’ inputs, a thread’s archive and promotion, and a move are strict', () => {
    expect(StreamMoveLineInputSchema.safeParse({ entry: t1, to: 'main' }).success).toBe(true);
    expect(StreamMoveLineInputSchema.safeParse({ entry: t1 }).success).toBe(false);
    expect(StreamArchiveThreadInputSchema.safeParse({ thread: t1, forget: true }).success).toBe(
      true,
    );
    expect(StreamArchiveThreadInputSchema.safeParse({ thread: 'x' }).success).toBe(false);
    expect(StreamCreateInputSchema.safeParse({ title: 't', seed_thread: t1 }).success).toBe(true);
    expect(StreamCreateInputSchema.safeParse({ title: 't', seed_thread: 'x' }).success).toBe(false);
    const thread = {
      id: t1,
      stream: ulid(),
      anchor: { entry: t2 },
      state: 'open',
      replies: 1,
      entries: [t1],
      last_at: t1,
    };
    expect(
      ChatThreadSchema.safeParse({ ...thread, archived: { at: t2, forget: true } }).success,
    ).toBe(true);
    expect(ChatThreadSchema.safeParse({ ...thread, archived: { at: t2, by: 'x' } }).success).toBe(
      false,
    );
    expect(
      ChatThreadSchema.safeParse({ ...thread, promoted: { node: ulid(), at: t2 } }).success,
    ).toBe(true);
    expect(ChatMoveSchema.safeParse({ entry: t2, from: 'main', to: t1, at: t2 }).success).toBe(
      true,
    );
    expect(ChatMoveSchema.safeParse({ entry: t2, from: 'main', to: 'x', at: t2 }).success).toBe(
      false,
    );
    expect(QuestionResolvedAsSchema.safeParse('withdrawn').success).toBe(true);
  });

  test('the archive notice is a quiet routed event', () => {
    expect(QUIET_EVENT_TYPES.has('thread_archived')).toBe(true);
    const node = ulid();
    const event = {
      id: `E-${ulid()}`,
      type: 'thread_archived',
      subject: node,
      payload: { thread: t1, on: t2, of: 'agent', quote: 'cent', withdrawn: [`Q-${ulid()}`] },
      by: 'human',
      at: t1,
      routing: [{ node, because: 'self' }],
    };
    expect(RoutedEventSchema.safeParse(event).success).toBe(true);
    expect(
      RoutedEventSchema.safeParse({ ...event, payload: { ...event.payload, extra: 1 } }).success,
    ).toBe(false);
  });

  test('Compact now: only a vendor known to take instructions, and only when its agent offers it', () => {
    expect(COMPACT_COMMANDS).toEqual({ claude: 'compact' });
    expect(compactCommandFor('claude', [{ name: 'compact' }])).toBe('compact');
    expect(compactCommandFor('claude', [{ name: 'init' }])).toBeUndefined();
    expect(compactCommandFor('codex', [{ name: 'compact' }])).toBeUndefined();
    expect(compactCommandFor(undefined, [{ name: 'compact' }])).toBeUndefined();
  });

  test('a ULID says when it was made', () => {
    const now = Date.UTC(2026, 9, 2, 10, 0, 0);
    expect(ulidTime(ulid(now))).toBe(now);
    expect(ulidTime('nope')).toBeNaN();
  });
});
