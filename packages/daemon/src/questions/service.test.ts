import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Question, QuestionId, Ticket } from '@agile-agents/shared';
import { validateMessage, validateQuestion } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import {
  EmptyQuestionTextError,
  QuestionAlreadyAnsweredError,
  QuestionNotFoundError,
  QuestionService,
  TicketEditRefusedError,
} from './service';

let repo: string;
let store: StateStore;
let questions: QuestionService;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-questions-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  questions = new QuestionService(store);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function ticket(id: Ticket['id'] = 'TKT-0001'): Ticket {
  return {
    id,
    title: 'fixture ticket',
    status: 'in_progress',
    contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
    depends: [],
    oracle_refs: [],
    kb_refs: [],
    history: [],
    security: false,
  };
}

function inbox(agent: string): Message[] {
  return store.listEntities(`bus/inbox/${agent}`, validateMessage);
}

function eventKinds(): string[] {
  return store.listEvents().map((e) => e.kind);
}

describe('QuestionService.raise', () => {
  test('writes board/questions/Q-*.yaml and a question_raised event', async () => {
    const q = await questions.raise({ raised_by: 'eng-1', text: 'is this ticket right?' });
    expect(q.id).toMatch(/^Q-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(q.status).toBe('open');
    // Read back through the store, not the return value — the file is the record.
    const onDisk = store.getEntity(`board/questions/${q.id}.yaml`, validateQuestion);
    expect(onDisk).toEqual(q);
    expect(eventKinds()).toContain('question_raised');
  });

  test('carries the ticket and options, and trims the text', async () => {
    await store.putTicket(ticket());
    const q = await questions.raise({
      raised_by: 'architect',
      text: '  fork: sqlite or files?  ',
      ticket: 'TKT-0001',
      options: ['sqlite', 'files'],
    });
    expect(q.text).toBe('fork: sqlite or files?');
    expect(q.ticket).toBe('TKT-0001');
    expect(q.options).toEqual(['sqlite', 'files']);
  });

  test('refuses empty text', async () => {
    expect(questions.raise({ raised_by: 'em', text: '   ' })).rejects.toThrow(
      EmptyQuestionTextError,
    );
  });

  test('list/listOpen read fresh from disk', async () => {
    const q = await questions.raise({ raised_by: 'eng-1', text: 'first' });
    await questions.raise({ raised_by: 'eng-1', text: 'second' });
    expect(questions.list()).toHaveLength(2);
    expect(questions.listOpen()).toHaveLength(2);
    await questions.answer(q.id, { answer: 'yes', by: 'human', resolved_as: 'reply' });
    expect(questions.listOpen().map((x) => x.text)).toEqual(['second']);
    expect(new QuestionService(store).list()).toHaveLength(2);
  });
});

describe('QuestionService.answer — reply', () => {
  test('stores the answer, marks it answered, logs it, and delivers to the raiser', async () => {
    await store.putTicket(ticket());
    const q = await questions.raise({
      raised_by: 'eng-1',
      text: 'the contract contradicts SPEC-auth-003',
      ticket: 'TKT-0001',
    });
    const result = await questions.answer(q.id, {
      answer: 'the spec wins — implement against it',
      by: 'human',
      resolved_as: 'reply',
    });
    expect(result.question.status).toBe('answered');
    expect(result.question.resolved_as).toBe('reply');
    expect(result.question.answered_by).toBe('human');
    expect(result.decision).toBeUndefined();

    const delivered = inbox('eng-1');
    expect(delivered).toHaveLength(1);
    const message = delivered[0] as Message;
    expect(message.kind).toBe('answer');
    expect(message.from).toBe('human');
    expect(message.ticket).toBe('TKT-0001');
    expect(message.promote_to).toBe('none');
    expect(message.body).toContain('the spec wins');
    expect(message.refs).toContain(`board/questions/${q.id}.yaml`);
    expect(eventKinds()).toContain('question_answered');
  });

  test('an already-answered question is refused, and an unknown id 404s', async () => {
    const q = await questions.raise({ raised_by: 'eng-1', text: 'q' });
    await questions.answer(q.id, { answer: 'a', by: 'human', resolved_as: 'reply' });
    expect(
      questions.answer(q.id, { answer: 'again', by: 'human', resolved_as: 'reply' }),
    ).rejects.toThrow(QuestionAlreadyAnsweredError);
    expect(() => questions.get('Q-01J9ZZZZZZZZZZZZZZZZZZZZZZ' as QuestionId)).toThrow(
      QuestionNotFoundError,
    );
  });

  test('an empty answer is refused and nothing is written', async () => {
    const q = await questions.raise({ raised_by: 'eng-1', text: 'q' });
    expect(
      questions.answer(q.id, { answer: '  ', by: 'human', resolved_as: 'reply' }),
    ).rejects.toThrow(EmptyQuestionTextError);
    expect(questions.get(q.id).status).toBe('open');
  });
});

describe('QuestionService.answer — record as decision', () => {
  test('publishes a DEC-* through the oracle write guard and links it', async () => {
    const q = await questions.raise({ raised_by: 'eng-1', text: 'which storage wins?' });
    const result = await questions.answer(q.id, {
      answer: 'files for v0; sqlite behind the same API later',
      by: 'human',
      resolved_as: 'decision',
    });
    const decisionId = result.decision?.entry.id as string;
    expect(decisionId).toMatch(/^DEC-\d{4}$/);
    expect(result.question.resolved_as).toBe(decisionId);
    // Published through the guard: indexed, on disk, with the answer as its rationale.
    expect(Object.keys(store.listOracleIndex())).toContain(decisionId);
    const { entry, body } = store.getOracleEntry(decisionId as never);
    expect(entry.rationale).toBe('files for v0; sqlite behind the same API later');
    expect(entry.by).toBe('human');
    expect(body).toContain('which storage wins?');
    expect(eventKinds()).toContain('oracle_put');

    const message = inbox('eng-1')[0] as Message;
    expect(message.promote_to).toBe('decision');
    expect(message.refs).toContain(decisionId);
  });

  test('decision ids do not collide with an existing one', async () => {
    const first = await questions.raise({ raised_by: 'em', text: 'one' });
    const second = await questions.raise({ raised_by: 'em', text: 'two' });
    const a = await questions.answer(first.id, {
      answer: 'a',
      by: 'architect',
      resolved_as: 'decision',
    });
    const b = await questions.answer(second.id, {
      answer: 'b',
      by: 'architect',
      resolved_as: 'decision',
    });
    expect(a.decision?.entry.id).not.toBe(b.decision?.entry.id);
    expect(b.decision?.entry.by).toBe('architect');
  });
});

describe('QuestionService.answer — ticket edit', () => {
  test('applies the edit through putTicket and links the ticket id', async () => {
    await store.putTicket(ticket());
    const q = await questions.raise({
      raised_by: 'eng-1',
      text: 'the title is wrong',
      ticket: 'TKT-0001',
    });
    const result = await questions.answer(q.id, {
      answer: 'retitled',
      by: 'human',
      resolved_as: 'ticket',
      edit: { title: 'corrected title' },
    });
    expect(result.question.resolved_as).toBe('TKT-0001');
    expect(store.getTicket('TKT-0001').title).toBe('corrected title');
  });

  test('refuses id/status/history edits and a question with no ticket', async () => {
    await store.putTicket(ticket());
    const q = await questions.raise({ raised_by: 'eng-1', text: 'q', ticket: 'TKT-0001' });
    expect(
      questions.answer(q.id, {
        answer: 'a',
        by: 'human',
        resolved_as: 'ticket',
        edit: { status: 'done' },
      }),
    ).rejects.toThrow(TicketEditRefusedError);
    expect(questions.get(q.id).status).toBe('open');

    const orphan = await questions.raise({ raised_by: 'eng-1', text: 'no ticket here' });
    expect(
      questions.answer(orphan.id, { answer: 'a', by: 'human', resolved_as: 'ticket', edit: {} }),
    ).rejects.toThrow(TicketEditRefusedError);
  });
});

describe('Question files', () => {
  test('every stored question validates against the shared schema', async () => {
    await questions.raise({ raised_by: 'eng-1', text: 'q' });
    const raw = store.listEntities('board/questions', (v) => v) as unknown[];
    for (const value of raw) expect(() => validateQuestion(value)).not.toThrow();
    expect((questions.list()[0] as Question).status).toBe('open');
  });
});
