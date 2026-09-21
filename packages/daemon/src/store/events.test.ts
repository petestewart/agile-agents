/**
 * T123 (cockpit design §7.4) — the append-only event log.
 *
 * The centrepiece is the reconstruction test: a scenario is driven through
 * the *real* services against a temp state home, then every stream's status
 * pair is rebuilt from `log/events.jsonl` alone and compared against what
 * the store reads off disk. If a state change forgets its event (or emits
 * one without the resulting status pair), the two disagree and this fails.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENT_KINDS, type Event, ulid } from '@agile-agents/shared';
import { runInit } from '../init';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { buildEvent, needsFsync, reconstructStreams } from './events';
import * as fs from './fs';

describe('buildEvent', () => {
  test('builds a minimal event with no scopes', () => {
    const event = buildEvent('repos_put', { data: { count: 1 } });
    expect(event.kind).toBe('repos_put');
    expect(event.stream).toBeUndefined();
    expect(event.session).toBeUndefined();
    expect(event.agent).toBeUndefined();
    expect(event.data).toEqual({ count: 1 });
    expect(() => new Date(event.ts).toISOString()).not.toThrow();
  });

  test('carries the stream/session/agent scopes when given', () => {
    const stream = ulid();
    const session = ulid();
    const event = buildEvent('thread_appended', { stream, session, agent: 'eng-1' });
    expect(event.stream).toBe(stream);
    expect(event.session).toBe(session);
    expect(event.agent).toBe('eng-1');
    expect(event.data).toEqual({});
  });

  test('rejects a kind that is no longer in EVENT_KINDS', () => {
    // @ts-expect-error — `ticket_put` went with the ticket layer (T122/T123).
    expect(() => buildEvent('ticket_put')).toThrow(/invalid Event/);
  });
});

describe('needsFsync — §7.4 "fsync on gate and land events"', () => {
  test.each(['gate_raised', 'gate_resolved', 'land_started', 'land_completed'])(
    '%s is fsynced',
    (kind) => {
      expect(needsFsync(kind)).toBe(true);
    },
  );

  test.each(['thread_appended', 'stream_created', 'hook_decision', 'tool_call'])(
    '%s is not fsynced',
    (kind) => {
      expect(needsFsync(kind)).toBe(false);
    },
  );
});

describe('reconstructStreams (pure)', () => {
  test('the last stream event wins and non-stream events are ignored', () => {
    const a = ulid();
    const events: Event[] = [
      {
        ts: '2026-09-01T00:00:00Z',
        kind: 'stream_created',
        stream: a,
        data: { agent_status: 'idle', human_status: 'open', archived: false },
      },
      { ts: '2026-09-01T00:00:01Z', kind: 'thread_appended', stream: a, data: {} },
      {
        ts: '2026-09-01T00:00:02Z',
        kind: 'stream_archived',
        stream: a,
        data: { agent_status: 'done', human_status: 'closed', archived: true },
      },
    ];
    expect(reconstructStreams(events)).toEqual({
      [a]: { agent_status: 'done', human_status: 'closed', archived: true },
    });
  });

  test('an empty log reconstructs nothing', () => {
    expect(reconstructStreams([])).toEqual({});
  });
});

describe('the event log against the real services', () => {
  let home: string;
  let stateRoot: string;
  let store: StateStore;
  let streams: StreamService;
  let questions: QuestionService;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agile-events-'));
    const init = runInit(home);
    stateRoot = init.stateRoot;
    store = StateStore.open(init.stateRoot);
    streams = new StreamService(store);
    questions = new QuestionService(store, streams);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function logLines(): Event[] {
    const path = join(stateRoot, 'log', 'events.jsonl');
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Event);
  }

  test('stream statuses rebuilt from the log alone match the records', async () => {
    const parent = await streams.create('human', { title: 'epic', goal: 'ship the cockpit' });
    const child = await streams.create('human', {
      title: 'child',
      goal: 'the first slice',
      parent: parent.id,
    });
    const third = await streams.create('human', { title: 'third', goal: 'the second slice' });

    await streams.appendThread('human', child.id, { kind: 'line', body: 'starting' });
    await streams.update('agent', child.id, { agent: { status: 'working' } });

    const question = await questions.raise({
      stream: child.id,
      text: 'tabs or spaces?',
      raised_by: 'human',
    });
    await questions.answer(question.id, { answer: 'spaces', by: 'human' });

    await streams.close('human', third.id);
    await streams.archive('human', parent.id);

    // Rebuilt from `log/events.jsonl` alone — nothing else is read.
    const rebuilt = reconstructStreams(logLines());

    const expected = Object.fromEntries(
      streams.list({ include_archived: true }).map((s) => [
        s.id,
        {
          agent_status: s.agent.status,
          human_status: s.human.status,
          archived: s.archived === true,
        },
      ]),
    );
    expect(Object.keys(expected).sort()).toEqual([parent.id, child.id, third.id].sort());
    expect(rebuilt).toEqual(expected);
  });

  test('every state change emits exactly one event, and every kind is a known kind', async () => {
    const before = logLines().length;
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    // create = one `stream_created` + the one `thread_appended` its opening
    // thread line mints (that line is itself a state change).
    expect(logLines().length).toBe(before + 2);

    const afterCreate = logLines().length;
    await streams.update('agent', stream.id, { agent: { status: 'working' } });
    expect(logLines().length).toBe(afterCreate + 1);

    for (const event of logLines()) {
      expect(EVENT_KINDS).toContain(event.kind as (typeof EVENT_KINDS)[number]);
    }
  });

  test('stream and thread events carry the stream id, so tail can filter by it', async () => {
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    await streams.appendThread('human', stream.id, { kind: 'line', body: 'hello' });
    const scoped = logLines().filter((e) => e.stream === stream.id);
    expect(scoped.map((e) => e.kind)).toEqual([
      'stream_created',
      'thread_appended',
      'thread_appended',
    ]);
  });

  test('a gate event is fsynced; a thread event is not', async () => {
    const appendSpy = spyOn(fs, 'appendJsonlLine');
    try {
      const stream = await streams.create('human', { title: 's', goal: 'g' });
      const threadCall = appendSpy.mock.calls.find(
        (call) => (call[1] as Event | undefined)?.kind === 'thread_appended',
      );
      expect(threadCall?.[2]).toEqual({ fsync: false });

      appendSpy.mockClear();
      await store.appendEvent(buildEvent('gate_raised', { stream: stream.id, data: { id: 'g1' } }));
      const gateCall = appendSpy.mock.calls.find(
        (call) => (call[1] as Event | undefined)?.kind === 'gate_raised',
      );
      expect(gateCall?.[2]).toEqual({ fsync: true });
    } finally {
      appendSpy.mockRestore();
    }
  });
});
