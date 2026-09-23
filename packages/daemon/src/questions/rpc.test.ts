import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Question, Stream } from '@agile-agents/shared';
import { runInit } from '../init';
import type { RpcMethodHandler } from '../rpc';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { buildQuestionRpcMethods } from './rpc';
import { QuestionService } from './service';

let repo: string;
let store: StateStore;
let methods: Record<string, RpcMethodHandler>;
let stream: Stream;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-questions-rpc-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  const streams = new StreamService(store);
  methods = buildQuestionRpcMethods(new QuestionService(store, streams));
  stream = await streams.create('human', { title: 'parser', goal: 'decide the dialect' });
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
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'is the contract right?',
    });
    expect(raised.stream).toBe(stream.id);
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
    expect(
      call('question.raise', { stream: stream.id, raised_by: 'nobody', text: 'x' }),
    ).rejects.toThrow(/invalid "raised_by"/);
    expect(
      call('question.raise', {
        stream: stream.id,
        raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
        text: '',
      }),
    ).rejects.toThrow(/invalid "text"/);
    // T121: `stream` replaced `ticket`, and it is required.
    expect(
      call('question.raise', { raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001', text: 'x' }),
    ).rejects.toThrow(/invalid "stream"/);
    expect(
      call('question.raise', {
        stream: 'TKT-0231',
        raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
        text: 'x',
      }),
    ).rejects.toThrow(/invalid "stream"/);
    expect(call('question.answer', { id: 'Q-1', answer: 'a', by: 'human' })).rejects.toThrow(
      /invalid "id"/,
    );
    expect(call('question.get', 'not-an-object')).rejects.toThrow(/params must be an object/);
  });

  // T121: `reply` is the only resolution left — `decision` and `ticket`
  // went with the oracle and the ticket model.
  test('any resolved_as other than "reply" is a param error', async () => {
    const raised = await call<Question>('question.raise', {
      stream: stream.id,
      raised_by: 'human',
      text: 'q',
    });
    for (const resolved_as of ['telepathy', 'decision', 'ticket']) {
      expect(
        call('question.answer', { id: raised.id, answer: 'a', by: 'human', resolved_as }),
      ).rejects.toThrow(/the only resolution is "reply"/);
    }
  });
});
