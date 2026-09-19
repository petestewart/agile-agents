import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Question } from '@agile-agents/shared';
import { runInit } from '../init';
import type { RpcMethodHandler } from '../rpc';
import { StateStore } from '../store';
import { buildQuestionRpcMethods } from './rpc';
import { QuestionService } from './service';

let repo: string;
let store: StateStore;
let methods: Record<string, RpcMethodHandler>;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-questions-rpc-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  methods = buildQuestionRpcMethods(new QuestionService(store));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function call<T>(method: string, params?: unknown): Promise<T> {
  const handler = methods[method];
  if (!handler) throw new Error(`no such method: ${method}`);
  return (await handler(params)) as T;
}

describe('question.* RPC', () => {
  test('raise -> list -> get -> answer round trip', async () => {
    const raised = await call<Question>('question.raise', {
      raised_by: 'eng-1',
      text: 'is the contract right?',
    });
    expect(raised.status).toBe('open');
    expect(await call<Question[]>('question.list', { open: true })).toHaveLength(1);
    expect((await call<Question>('question.get', { id: raised.id })).id).toBe(raised.id);

    const answered = await call<{ question: Question }>('question.answer', {
      id: raised.id,
      answer: 'yes, proceed',
      resolved_as: 'reply',
      by: 'human',
    });
    expect(answered.question.status).toBe('answered');
    expect(await call<Question[]>('question.list', { open: true })).toHaveLength(0);
    expect(await call<Question[]>('question.list')).toHaveLength(1);
  });

  test('question.list tolerates no params', async () => {
    expect(await call<Question[]>('question.list')).toEqual([]);
  });

  test('validates params at the boundary rather than throwing a TypeError', async () => {
    expect(call('question.raise', { raised_by: 'nobody', text: 'x' })).rejects.toThrow(
      /invalid "raised_by"/,
    );
    expect(call('question.raise', { raised_by: 'eng-1', text: '' })).rejects.toThrow(
      /invalid "text"/,
    );
    expect(
      call('question.raise', { raised_by: 'eng-1', text: 'x', ticket: 'nope' }),
    ).rejects.toThrow(/invalid "ticket"/);
    expect(call('question.answer', { id: 'Q-1', answer: 'a', by: 'human' })).rejects.toThrow(
      /invalid "id"/,
    );
    expect(call('question.get', 'not-an-object')).rejects.toThrow(/params must be an object/);
  });

  test('an unknown resolved_as, and a ticket resolution with no edit, are param errors', async () => {
    const raised = await call<Question>('question.raise', { raised_by: 'em', text: 'q' });
    expect(
      call('question.answer', {
        id: raised.id,
        answer: 'a',
        by: 'human',
        resolved_as: 'telepathy',
      }),
    ).rejects.toThrow(/invalid "resolved_as"/);
    expect(
      call('question.answer', { id: raised.id, answer: 'a', by: 'human', resolved_as: 'ticket' }),
    ).rejects.toThrow(/"edit" must be an object/);
  });
});
