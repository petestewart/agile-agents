/**
 * T120: the `stream.*` RPC edge. The two things only this layer can get
 * wrong are param validation and the principal stamp (design §2.2) — a
 * caller must not be able to write `agent.*` or name its own principal.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Stream, ThreadEntry } from '@agile-agents/shared';
import { ulid } from '@agile-agents/shared';
import { runInit } from '../init';
import { QuestionService } from '../questions/service';
import type { RpcMethodHandler } from '../rpc';
import { AlreadyExistsError, StateStore } from '../store';
import { buildStreamRpcMethods } from './rpc';
import { StreamService } from './service';

let home: string;
let store: StateStore;
let methods: Record<string, RpcMethodHandler>;

const call = async <T>(method: string, params: unknown): Promise<T> => {
  const handler = methods[method];
  if (!handler) throw new Error(`no such method: ${method}`);
  return (await handler(params)) as T;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-stream-rpc-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  methods = buildStreamRpcMethods(new StreamService(store));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function create(title = 'a stream'): Promise<Stream> {
  return call<Stream>('stream.create', { title, goal: 'g' });
}

test('the method table is exactly the eight stream verbs', () => {
  expect(Object.keys(methods).sort()).toEqual([
    'stream.archive',
    'stream.close',
    'stream.create',
    'stream.get',
    'stream.list',
    'stream.thread_append',
    'stream.thread_read',
    'stream.update',
  ]);
});

describe('caller-input errors are invalid params, not internal errors (T126)', () => {
  const codeOf = async (run: () => Promise<unknown>): Promise<number | undefined> => {
    const err = (await run().then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: number; message: string } | undefined;
    expect(err).toBeDefined();
    expect(err?.message).not.toContain('undefined');
    expect(err?.message).not.toContain('null');
    return err?.code;
  };

  test('a parent cycle on stream.update is -32602 and names the chain', async () => {
    const a = await create('a');
    const b = await call<Stream>('stream.create', { title: 'b', goal: 'g', parent: a.id });
    const err = (await call('stream.update', { id: a.id, parent: b.id }).then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: number; message: string };
    expect(err.code).toBe(-32602);
    expect(err.message).toContain('parent cycle');
    expect(err.message).toContain(`${a.id} -> ${b.id} -> ${a.id}`);
    expect(err.message).not.toContain('undefined');
    expect(err.message).not.toContain('null');
  });

  test('self-parent on stream.update is -32602', async () => {
    const a = await create('a');
    expect(await codeOf(() => call('stream.update', { id: a.id, parent: a.id }))).toBe(-32602);
  });

  test('an unknown parent on stream.create is -32602', async () => {
    expect(
      await codeOf(() => call('stream.create', { title: 't', goal: 'g', parent: ulid() })),
    ).toBe(-32602);
  });

  test('an unregistered repo on stream.create is -32602', async () => {
    expect(await codeOf(() => call('stream.create', { title: 't', goal: 'g', repo: 'nope' }))).toBe(
      -32602,
    );
  });

  test('a duplicate stream id is -32602, and a real fault stays internal', async () => {
    const createThrowing = async (err: Error): Promise<{ code?: number } | undefined> => {
      const service = new StreamService(store);
      service.create = () => Promise.reject(err);
      const handler = buildStreamRpcMethods(service)['stream.create'];
      if (!handler) throw new Error('no stream.create');
      return (await Promise.resolve(handler({ title: 't', goal: 'g' })).then(
        () => undefined,
        (e: unknown) => e,
      )) as { code?: number } | undefined;
    };
    expect((await createThrowing(new AlreadyExistsError('Stream', ulid())))?.code).toBe(-32602);
    // A genuine fault must not be relabelled as the caller's fault: no code,
    // so `dispatch()` reports -32603.
    expect((await createThrowing(new Error('disk on fire')))?.code).toBeUndefined();
  });
});

describe('principal (design §2.2)', () => {
  test('never accepts a principal from params', async () => {
    const stream = await create();
    await expect(
      call('stream.update', { id: stream.id, principal: 'daemon', human: { status: 'landed' } }),
    ).rejects.toThrow(/principal is stamped by the daemon/);
  });

  test('refuses an agent.* patch at the edge with a reason', async () => {
    const stream = await create();
    await expect(
      call('stream.update', { id: stream.id, agent: { status: 'working' } }),
    ).rejects.toThrow(/agent-owned/);
  });

  test('writes land as the human principal', async () => {
    const stream = await create();
    const updated = await call<Stream>('stream.update', {
      id: stream.id,
      human: { status: 'waiting_on_you' },
    });
    expect(updated.human.status).toBe('waiting_on_you');
    const entry = await call<ThreadEntry>('stream.thread_append', {
      id: stream.id,
      body: 'from the CLI',
    });
    expect(entry.by).toBe('human');
    expect(entry.kind).toBe('line');
  });
});

describe('params', () => {
  test('rejects a non-object params and a non-ULID id', async () => {
    await expect(call('stream.get', 'nope')).rejects.toThrow(/params must be an object/);
    await expect(call('stream.get', { id: 'TKT-0001' })).rejects.toThrow(/invalid "id"/);
  });

  test('rejects an unknown thread kind and a bad page cursor', async () => {
    const stream = await create();
    await expect(
      call('stream.thread_append', { id: stream.id, kind: 'shout', body: 'x' }),
    ).rejects.toThrow(/invalid "kind"/);
    await expect(call('stream.thread_read', { id: stream.id, after: -3 })).rejects.toThrow(
      /invalid "after"/,
    );
  });

  test('rejects an unknown field on create (the schema is strict)', async () => {
    await expect(call('stream.create', { title: 't', goal: 'g', archived: true })).rejects.toThrow(
      /StreamCreateInput/,
    );
  });
});

describe('list / close / archive', () => {
  test('list returns a tree and hides archived unless asked', async () => {
    const root = await create('root');
    const child = await call<Stream>('stream.create', {
      title: 'child',
      goal: 'g',
      parent: root.id,
    });
    const before = await call<{ tree: Array<{ stream: Stream; children: unknown[] }> }>(
      'stream.list',
      {},
    );
    expect(before.tree).toHaveLength(1);
    expect(before.tree[0]?.children).toHaveLength(1);

    await call('stream.archive', { id: child.id });
    const after = await call<{ tree: Array<{ children: unknown[] }> }>('stream.list', {});
    expect(after.tree[0]?.children).toHaveLength(0);
    const all = await call<{ tree: Array<{ children: unknown[] }> }>('stream.list', {
      include_archived: true,
    });
    expect(all.tree[0]?.children).toHaveLength(1);
  });

  test('close sets human.status and an unknown stream is not found', async () => {
    const stream = await create();
    const closed = await call<Stream>('stream.close', { id: stream.id, note: 'done thinking' });
    expect(closed.human.status).toBe('closed');
    expect(closed.human.note).toBe('done thinking');
    await expect(call('stream.close', { id: ulid() })).rejects.toThrow(/Stream/);
  });
});

describe('classifier opt-out over stream.update (T150, §6.4)', () => {
  test('"off" sets the opt-out and "on" clears it', async () => {
    const created = await create();
    const off = await call<Stream>('stream.update', { id: created.id, classifier: 'off' });
    expect(off.classifier).toBe('off');
    const on = await call<Stream>('stream.update', { id: created.id, classifier: 'on' });
    expect(on.classifier).toBeUndefined();
    expect('classifier' in on).toBe(false);
  });

  test('anything else is invalid params', async () => {
    const created = await create();
    const err = (await call('stream.update', { id: created.id, classifier: false }).then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: number } | undefined;
    expect(err?.code).toBe(-32602);
  });
});

describe('stream.thread_append as `agile stream say` (T169)', () => {
  test('a human line prompted into the asking session answers its open question', async () => {
    const streams = new StreamService(store);
    const questions = new QuestionService(store, streams);
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    const session = ulid();
    const asked = await questions.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session,
      text: 'comma or semicolon?',
    });
    const other = await streams.create('human', { title: 'no worker', goal: 'g' });
    const withReply = buildStreamRpcMethods(streams, {
      reply: {
        // A stand-in for `AttachService.say`: only `stream` has a live worker.
        say: async (id, body) => ({
          entry: await streams.appendThread('human', id, { kind: 'line', body }),
          ...(id === stream.id ? { prompted: session } : {}),
        }),
        questions,
      },
    });
    const say = (id: string, body: string) =>
      (withReply['stream.thread_append'] as RpcMethodHandler)({ id, kind: 'line', body });

    // No live session to deliver to: nothing closes.
    await say(other.id, 'semicolons');
    expect(questions.get(asked.id).status).toBe('open');

    const entry = (await say(stream.id, 'semicolons')) as ThreadEntry;
    expect(entry.by).toBe('human');
    const after = questions.get(asked.id);
    expect(after.status).toBe('answered');
    expect(after.answered_by).toBe('human');
    expect(after.answer).toContain('semicolons');
  });
});
