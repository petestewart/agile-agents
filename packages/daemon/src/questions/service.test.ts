/**
 * T121: `QuestionService` re-keyed to streams (cockpit design §1.4, §2.3).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Question, QuestionId, Stream } from '@agile-agents/shared';
import { ulid, validateMessage, validateQuestion } from '@agile-agents/shared';
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

function inbox(agent: string): Message[] {
  return store.listEntities(`bus/inbox/${agent}`, validateMessage);
}

function eventKinds(): string[] {
  return store.listEvents().map((e) => e.kind);
}

describe('QuestionService.raise', () => {
  test('writes questions/<id>.yaml in the home, not board/questions/', async () => {
    const q = await questions.raise({
      stream: stream.id,
      raised_by: 'eng-1',
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
      raised_by: 'eng-1',
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
      questions.raise({ stream: '0'.repeat(26), raised_by: 'eng-1', text: 'x' }),
    ).rejects.toThrow();
    await expect(
      questions.raise({ stream: stream.id, raised_by: 'eng-1', text: '   ' }),
    ).rejects.toThrow(EmptyQuestionTextError);
  });
});

describe('QuestionService.answer', () => {
  async function raised(): Promise<Question> {
    return questions.raise({
      stream: stream.id,
      raised_by: 'eng-1',
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

  test('delivers the answer to the waiting session (the deliverNote path)', async () => {
    const q = await raised();
    await questions.answer(q.id, { answer: 'semicolon', by: 'human' });
    const delivered = inbox('eng-1');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.kind).toBe('answer');
    expect(delivered[0]?.body).toContain('semicolon');
    expect(delivered[0]?.refs).toContain(`questions/${q.id}.yaml`);
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
    const a = await questions.raise({ stream: stream.id, raised_by: 'eng-1', text: 'first' });
    await questions.raise({ stream: stream.id, raised_by: 'eng-1', text: 'second' });
    expect(questions.listOpen()).toHaveLength(2);
    await questions.answer(a.id, { answer: 'done', by: 'human' });
    expect(new QuestionService(store, streams).listOpen().map((q) => q.text)).toEqual(['second']);
  });
});
