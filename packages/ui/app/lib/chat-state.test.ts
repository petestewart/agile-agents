/**
 * T051 — the chat reducer's delta-to-turn matching. Plain `bun test`, no DOM
 * and no browser: the reducer is a pure function precisely so the rule that
 * broke live ("a delta belongs to the line whose `message_id` it carries,
 * never to whichever EM line happens to be last") can be pinned here.
 */

import { describe, expect, test } from 'bun:test';
import type { ChatEntry } from './api';
import {
  type ChatAction,
  type ChatState,
  PENDING_HUMAN_ID,
  PENDING_LINE_ID,
  chatReducer,
  initialChatState,
} from './chat-state';

function fold(state: ChatState, ...actions: ChatAction[]): ChatState {
  return actions.reduce(chatReducer, state);
}

const TS = '2026-09-19T10:00:00.000Z';

/** A thread with one finished exchange, as `GET /api/chat/em` returns it. */
const PRIOR: ChatEntry[] = [
  { id: '01H0', ts: TS, from: 'human', body: 'status?' },
  { id: '01H1', ts: TS, from: 'em', body: 'PREVIOUS REPLY' },
];

function send(body = 'what is left on all tickets'): ChatAction {
  return { type: 'send', body, ts: TS };
}

describe('chatReducer — send', () => {
  test('appends the human line and an EMPTY pending bubble, never the previous reply', () => {
    const state = fold(initialChatState, { type: 'history', entries: PRIOR }, send());
    expect(state.lines.map((l) => [l.from, l.body, l.pending ?? false])).toEqual([
      ['you', 'status?', false],
      ['em', 'PREVIOUS REPLY', false],
      ['you', 'what is left on all tickets', false],
      ['em', '', true],
    ]);
    // The pending bubble is its own line, not the previous EM line reused.
    expect(state.lines[3]?.id).toBe(PENDING_LINE_ID);
    expect(state.turnId).toBe(PENDING_LINE_ID);
  });

  test('a second send while a turn is in flight is refused, not queued into a second bubble', () => {
    const state = fold(initialChatState, send('first'), send('second'));
    expect(state.lines.filter((l) => l.from === 'you').map((l) => l.body)).toEqual(['first']);
    expect(state.lines.filter((l) => l.pending)).toHaveLength(1);
  });

  test('the daemon ids replace the local ones', () => {
    const state = fold(initialChatState, send(), {
      type: 'turn_started',
      messageId: '01H2',
      replyId: '01H3',
    });
    expect(state.lines.map((l) => l.id)).toEqual(['01H2', '01H3']);
    expect(state.turnId).toBe('01H3');
    expect(state.lines.find((l) => l.id === PENDING_HUMAN_ID)).toBeUndefined();
  });
});

describe('chatReducer — deltas are matched by message_id', () => {
  test('deltas fill the pending bubble and clear the indicator; the previous reply is untouched', () => {
    const state = fold(
      initialChatState,
      { type: 'history', entries: PRIOR },
      send(),
      { type: 'turn_started', messageId: '01H2', replyId: '01H3' },
      {
        type: 'frame',
        frame: { type: 'chat_delta', thread: 'em', message_id: '01H3', text: 'NEW ' },
      },
      {
        type: 'frame',
        frame: { type: 'chat_delta', thread: 'em', message_id: '01H3', text: 'REPLY' },
      },
    );
    const reply = state.lines.find((l) => l.id === '01H3');
    expect(reply?.body).toBe('NEW REPLY');
    expect(reply?.pending).toBe(false);
    expect(reply?.streaming).toBe(true);
    // The old reply is exactly as it was — no delta ever lands on it.
    expect(state.lines.find((l) => l.id === '01H1')?.body).toBe('PREVIOUS REPLY');
  });

  test('a delta that beats the POST response adopts the still-unnamed placeholder', () => {
    const state = fold(initialChatState, { type: 'history', entries: PRIOR }, send(), {
      type: 'frame',
      frame: { type: 'chat_delta', thread: 'em', message_id: '01H9', text: 'early' },
    });
    expect(state.turnId).toBe('01H9');
    const adopted = state.lines.find((l) => l.id === '01H9');
    expect(adopted?.body).toBe('early');
    expect(adopted?.pending).toBe(false);
    // The previous EM line is still the previous EM line.
    expect(state.lines.filter((l) => l.from === 'em').map((l) => l.body)).toEqual([
      'PREVIOUS REPLY',
      'early',
    ]);
  });

  test("another tab's turn opens its own line rather than appending to the last EM line", () => {
    const state = fold(
      initialChatState,
      { type: 'history', entries: PRIOR },
      {
        type: 'frame',
        frame: { type: 'chat_delta', thread: 'em', message_id: '01HX', text: 'elsewhere' },
        ts: TS,
      },
    );
    expect(state.lines.map((l) => l.body)).toEqual(['status?', 'PREVIOUS REPLY', 'elsewhere']);
    expect(state.turnId).toBeUndefined();
  });
});

describe('chatReducer — how a turn ends', () => {
  test('chat_turn_end drops the indicator and frees the input', () => {
    const state = fold(
      initialChatState,
      send(),
      { type: 'turn_started', messageId: '01H2', replyId: '01H3' },
      {
        type: 'frame',
        frame: { type: 'chat_delta', thread: 'em', message_id: '01H3', text: 'hi' },
      },
      { type: 'frame', frame: { type: 'chat_turn_end', thread: 'em', message_id: '01H3' } },
    );
    expect(state.turnId).toBeUndefined();
    const reply = state.lines.find((l) => l.id === '01H3');
    expect(reply?.streaming).toBe(false);
    expect(reply?.pending).toBe(false);
    expect(reply?.error).toBeUndefined();
  });

  test('a failed turn renders its reason in the bubble instead of hanging', () => {
    const state = fold(
      initialChatState,
      send(),
      { type: 'turn_started', messageId: '01H2', replyId: '01H3' },
      {
        type: 'frame',
        frame: {
          type: 'chat_turn_end',
          thread: 'em',
          message_id: '01H3',
          error: 'resident EM turn failed: boom',
        },
      },
    );
    expect(state.turnId).toBeUndefined();
    const reply = state.lines.find((l) => l.id === '01H3');
    expect(reply?.pending).toBe(false);
    expect(reply?.error).toContain('resident EM turn failed: boom');
  });

  test('an end for a turn with no deltas still lands on the unnamed placeholder', () => {
    const state = fold(initialChatState, send(), {
      type: 'frame',
      frame: { type: 'chat_turn_end', thread: 'em', message_id: '01HZ', error: 'gone' },
    });
    expect(state.turnId).toBeUndefined();
    expect(state.lines.find((l) => l.from === 'em')?.error).toContain('gone');
  });

  test("another tab's turn_end does not end this browser's named turn", () => {
    const state = fold(
      initialChatState,
      send(),
      { type: 'turn_started', messageId: '01H2', replyId: '01H3' },
      { type: 'frame', frame: { type: 'chat_turn_end', thread: 'em', message_id: '01HOTHER' } },
    );
    expect(state.turnId).toBe('01H3');
    expect(state.lines.find((l) => l.id === '01H3')?.pending).toBe(true);
  });

  test('send_failed and turn_timeout both explain themselves in the bubble and free the input', () => {
    for (const action of [
      { type: 'send_failed', reason: 'no resident EM session is configured' } as const,
      { type: 'turn_timeout', reason: 'no reply arrived within 150s' } as const,
    ]) {
      const state = fold(initialChatState, send(), action);
      expect(state.turnId).toBeUndefined();
      const bubble = state.lines.find((l) => l.from === 'em');
      expect(bubble?.pending).toBe(false);
      expect(bubble?.error).toBe(action.reason);
    }
  });
});

describe('chatReducer — history', () => {
  test('a reload shows the stored thread and no placeholder at all', () => {
    // A reload starts from scratch: no turn, so nothing to preserve.
    const state = fold(initialChatState, {
      type: 'history',
      entries: [...PRIOR, { id: '01H3', ts: TS, from: 'em', body: 'NEW REPLY' }],
    });
    expect(state.lines.some((l) => l.pending)).toBe(false);
    expect(state.lines.some((l) => l.id.startsWith('local:'))).toBe(false);
    expect(state.turnId).toBeUndefined();
  });

  test('a mid-turn history read keeps the partial reply and the placeholder', () => {
    const mid = fold(
      initialChatState,
      { type: 'history', entries: PRIOR },
      send(),
      { type: 'turn_started', messageId: '01H2', replyId: '01H3' },
      {
        type: 'frame',
        frame: { type: 'chat_delta', thread: 'em', message_id: '01H3', text: 'par' },
      },
      // The human's line is on the bus; the reply is not, until the turn ends.
      { type: 'history', entries: [...PRIOR, { id: '01H2', ts: TS, from: 'human', body: 'q' }] },
    );
    expect(mid.lines.map((l) => l.body)).toEqual(['status?', 'PREVIOUS REPLY', 'q', 'par']);
    expect(mid.turnId).toBe('01H3');
  });

  test('the stored reply replaces the streamed one, keeping a reported error visible', () => {
    const state = fold(
      initialChatState,
      send(),
      { type: 'turn_started', messageId: '01H2', replyId: '01H3' },
      {
        type: 'frame',
        frame: { type: 'chat_turn_end', thread: 'em', message_id: '01H3', error: 'timed out' },
      },
      {
        type: 'history',
        entries: [
          { id: '01H2', ts: TS, from: 'human', body: 'q' },
          { id: '01H3', ts: TS, from: 'em', body: '(the EM session could not answer: timed out)' },
        ],
      },
    );
    expect(state.lines).toHaveLength(2);
    expect(state.lines[1]?.body).toContain('could not answer');
    expect(state.lines[1]?.error).toContain('timed out');
    expect(state.lines.some((l) => l.pending)).toBe(false);
  });
});
