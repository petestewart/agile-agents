/**
 * T121: `QuestionService` re-keyed to streams (cockpit design §1.4, §2.3).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, Question, QuestionId, Stream } from '@agile-agents/shared';
import { ulid, validateAgentMessage, validateQuestion } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import {
  EmptyQuestionTextError,
  QuestionAlreadyAnsweredError,
  QuestionNotFoundError,
  QuestionService,
} from './service';

let repo: string;
let home: string;
let store: StateStore;
let streams: StreamService;
let questions: QuestionService;
let stream: Stream;
const SESSION = ulid();

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-questions-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  home = init.stateRoot;
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  questions = new QuestionService(store, streams);
  // A stream with NO repo — the acceptance criterion's shape.
  stream = await streams.create('human', { title: 'parser', goal: 'decide the CSV dialect' });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function inbox(agent: string): AgentMessage[] {
  return store.listEntities(`bus/inbox/${agent}`, validateAgentMessage);
}

function eventKinds(): string[] {
  return store.listEvents().map((e) => e.kind);
}

describe('QuestionService.raise', () => {
  test('writes questions/<id>.yaml in the home, not board/questions/', async () => {
    const q = await questions.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session: SESSION,
      text: 'comma or semicolon?',
    });
    expect(q.id).toMatch(/^Q-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(q.stream).toBe(stream.id);
    expect(q.status).toBe('open');
    expect(existsSync(join(home, 'questions', `${q.id}.yaml`))).toBe(true);
    expect(existsSync(join(home, 'board', 'questions', `${q.id}.yaml`))).toBe(false);
    expect(store.getEntity(`questions/${q.id}.yaml`, validateQuestion).text).toBe(
      'comma or semicolon?',
    );
    expect(eventKinds()).toContain('question_raised');
  });

  test('flips the stream to question / waiting_on_you and appends a question thread entry', async () => {
    await questions.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session: SESSION,
      text: 'comma or semicolon?',
    });
    const after = streams.get(stream.id);
    expect(after.agent.status).toBe('question');
    expect(after.human.status).toBe('waiting_on_you');

    const entries = streams.readThread(stream.id).entries;
    const asked = entries.find((e) => e.kind === 'question');
    expect(asked?.body).toBe('comma or semicolon?');
    expect(asked?.by).toBe(`agent:${SESSION}`);
  });

  test('the operator raising one from the UI writes the entry as `human`', async () => {
    await questions.raise({ stream: stream.id, raised_by: 'human', text: 'who owns this?' });
    const asked = streams.readThread(stream.id).entries.find((e) => e.kind === 'question');
    expect(asked?.by).toBe('human');
  });

  test('refuses an unknown stream and empty text', async () => {
    await expect(
      questions.raise({
        stream: '0'.repeat(26),
        raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
        text: 'x',
      }),
    ).rejects.toThrow();
    await expect(
      questions.raise({ stream: stream.id, raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001', text: '   ' }),
    ).rejects.toThrow(EmptyQuestionTextError);
  });
});

describe('QuestionService.answer', () => {
  async function raised(): Promise<Question> {
    return questions.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session: SESSION,
      text: 'comma or semicolon?',
    });
  }

  /** A live `SessionRef` on the fixture stream — `answer` only returns a stream to `working` when there is still a session to go back to (T130). */
  async function attachLiveSession(): Promise<void> {
    await store.updateStream('daemon', stream.id, (before) => ({
      ...before,
      sessions: [
        { id: SESSION, vendor: 'claude', model: 'default', role: 'worker', status: 'running' },
      ],
    }));
  }

  test('records the answer, appends the thread entry, and puts the stream back to work', async () => {
    await attachLiveSession();
    const q = await raised();
    const result = await questions.answer(q.id, { answer: 'semicolon', by: 'human' });
    expect(result.question.status).toBe('answered');
    expect(result.question.resolved_as).toBe('reply');
    expect(result.question.answer).toBe('semicolon');

    const after = streams.get(stream.id);
    expect(after.agent.status).toBe('working');
    expect(after.human.status).toBe('open');

    const answer = streams.readThread(stream.id).entries.find((e) => e.kind === 'answer');
    expect(answer?.body).toBe('semicolon');
    expect(answer?.by).toBe('human');
    expect(eventKinds()).toContain('question_answered');
  });

  test('a stream with no live session goes back to idle, not working', async () => {
    const q = await raised();
    await questions.answer(q.id, { answer: 'semicolon', by: 'human' });
    // Nothing is attached: claiming `working` would show an agent at work
    // on a stream with no process behind it (Phase 2 Discovered Issues).
    expect(streams.get(stream.id).agent.status).toBe('idle');
    expect(streams.get(stream.id).human.status).toBe('open');
  });

  test('T336: an answer after the session ended leaves `done`, not the human-stop `idle`', async () => {
    const q = await raised();
    // The asking session then ended on its own: the exit path wrote `done`.
    await store.updateStream('daemon', stream.id, (before) => ({
      ...before,
      agent: { ...before.agent, status: 'done' },
      sessions: [
        { id: SESSION, vendor: 'claude', model: 'default', role: 'worker', status: 'stopped' },
      ],
    }));
    await questions.answer(q.id, { answer: 'semicolon', by: 'human' });
    expect(streams.get(stream.id).agent.status).toBe('done');
    expect(streams.get(stream.id).human.status).toBe('open');
  });

  test('delivers the answer to the session that asked, and writes no mail (T137)', async () => {
    const delivered: Array<{ session: string; answer?: string }> = [];
    const service = new QuestionService(store, streams, {
      deliver: (session, question) => {
        delivered.push({
          session,
          ...(question.answer !== undefined ? { answer: question.answer } : {}),
        });
      },
    });
    const q = await service.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session: SESSION,
      text: 'comma or semicolon?',
    });
    await service.answer(q.id, { answer: 'semicolon', by: 'human' });
    // The prompt goes to the session that asked — the record names it —
    // and nothing is written to a mailbox nobody reads.
    expect(delivered).toEqual([{ session: SESSION, answer: 'semicolon' }]);
    expect(inbox('01ARZ3NDEKTSV4RRFFQ69GE001')).toHaveLength(0);
    expect(inbox(SESSION)).toHaveLength(0);
  });

  test('a question raised by the operator has no session to deliver to', async () => {
    const delivered: string[] = [];
    const service = new QuestionService(store, streams, {
      deliver: (session) => {
        delivered.push(session);
      },
    });
    const q = await service.raise({ stream: stream.id, raised_by: 'human', text: 'ship it?' });
    await service.answer(q.id, { answer: 'yes', by: 'human' });
    expect(delivered).toEqual([]);
  });

  test('answering twice is refused; an unknown id is a QuestionNotFoundError', async () => {
    const q = await raised();
    await questions.answer(q.id, { answer: 'semicolon', by: 'human' });
    await expect(questions.answer(q.id, { answer: 'again', by: 'human' })).rejects.toThrow(
      QuestionAlreadyAnsweredError,
    );
    expect(() => questions.get(`Q-${'0'.repeat(26)}` as QuestionId)).toThrow(QuestionNotFoundError);
  });

  test('an empty answer is refused', async () => {
    const q = await raised();
    await expect(questions.answer(q.id, { answer: '  ', by: 'human' })).rejects.toThrow(
      EmptyQuestionTextError,
    );
  });
});

describe('listOpen', () => {
  test('reads fresh from disk and only returns open questions', async () => {
    const a = await questions.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'first',
    });
    await questions.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'second',
    });
    expect(questions.listOpen()).toHaveLength(2);
    await questions.answer(a.id, { answer: 'done', by: 'human' });
    expect(new QuestionService(store, streams).listOpen().map((q) => q.text)).toEqual(['second']);
  });
});

describe('a gate decision supersedes the questions the same session left open (T145)', () => {
  test('resolves them as superseded, with a thread line naming the gate', async () => {
    const mine = await questions.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session: SESSION,
      text: 'comma or semicolon?',
    });
    const other = await questions.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session: ulid(),
      text: 'another session, untouched',
    });

    const superseded = await questions.supersede(SESSION, 'HIL-01ABCDEFGHJKMNPQRSTVWXYZ');
    expect(superseded.map((q) => q.id)).toEqual([mine.id]);

    const after = questions.get(mine.id as QuestionId);
    expect(after.status).toBe('answered');
    expect(after.resolved_as).toBe('superseded');
    expect(after.answer).toBe('superseded by HIL-01ABCDEFGHJKMNPQRSTVWXYZ');
    expect(after.answered_by).toBe('daemon');
    expect(questions.get(other.id as QuestionId).status).toBe('open');
    expect(questions.listOpen().map((q) => q.id)).toEqual([other.id]);

    const bodies = streams.readThread(stream.id, { limit: 100 }).entries.map((e) => e.body);
    expect(bodies).toContain(`question ${mine.id} superseded by HIL-01ABCDEFGHJKMNPQRSTVWXYZ`);
  });

  test('an already answered question is left exactly as it was', async () => {
    const q = await questions.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session: SESSION,
      text: 'comma or semicolon?',
    });
    await questions.answer(q.id as QuestionId, { answer: 'semicolon', by: 'pete' });
    expect(await questions.supersede(SESSION, 'HIL-01ABCDEFGHJKMNPQRSTVWXYZ')).toEqual([]);
    const after = questions.get(q.id as QuestionId);
    expect(after.resolved_as).toBe('reply');
    expect(after.answer).toBe('semicolon');
  });
});

describe('a human reply on the thread answers the asking session (T169)', () => {
  test('closes that session’s open questions as reply by human, citing the line', async () => {
    const mine = await questions.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session: SESSION,
      text: 'comma or semicolon?',
    });
    const other = await questions.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session: ulid(),
      text: 'another session, untouched',
    });

    const line = { body: 'semicolon, please', ts: '2026-09-23T10:00:00.000Z' };
    const answered = await questions.answerFromThread(SESSION, line);
    expect(answered.map((q) => q.id)).toEqual([mine.id]);

    const after = questions.get(mine.id as QuestionId);
    expect(after.status).toBe('answered');
    expect(after.resolved_as).toBe('reply');
    expect(after.answered_by).toBe('human');
    expect(after.answer).toContain('semicolon, please');
    expect(after.answer).toContain(line.ts);
    expect(questions.get(other.id as QuestionId).status).toBe('open');

    const entries = streams.readThread(stream.id, { limit: 100 }).entries;
    expect(
      entries.some((e) => e.kind === 'event' && e.body.includes(`question ${mine.id} answered`)),
    ).toBe(true);
    expect(streams.get(stream.id).human.status).toBe('open');
    const event = store
      .listEvents()
      .filter((e) => e.kind === 'question_answered')
      .at(-1);
    expect(event?.agent).toBe('human');
  });

  test('a session with nothing open closes nothing', async () => {
    expect(await questions.answerFromThread(ulid(), { body: 'hi', ts: 'now' })).toEqual([]);
  });
});
