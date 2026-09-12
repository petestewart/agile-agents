/**
 * T041 — the EM chat thread on the bus: history, the streamed reply, the
 * over-cap pointer, and the "no resident EM" degradation.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MESSAGE_BODY_MAX_CHARS } from '@agile-agents/shared';
import { Bus } from '../bus';
import { GateService } from '../gates';
import { runInit } from '../init';
import { QuestionService } from '../questions';
import { StateStore } from '../store';
import { EmChatService, renderAttentionQueue, renderReplyBody } from './chat';

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;

/** A stand-in resident EM: answers every prompt with `chunks`, and records what it was asked. */
function fakeResident(chunks: string[]) {
  const prompts: string[] = [];
  return {
    prompts,
    prompt(text: string) {
      prompts.push(text);
      const iterate = async function* () {
        for (const chunk of chunks) yield chunk;
      };
      return Object.assign(
        { [Symbol.asyncIterator]: iterate },
        { done: Promise.resolve(chunks.join('')) },
      );
    },
  };
}

function collector() {
  const deltas: Array<{ id: string; text: string }> = [];
  const ends: Array<{ id: string; error?: string }> = [];
  return {
    deltas,
    ends,
    hooks: {
      onDelta: (id: string, text: string) => deltas.push({ id, text }),
      onEnd: (id: string, error?: string) => ends.push({ id, ...(error ? { error } : {}) }),
    },
  };
}

async function settle(ends: Array<unknown>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (ends.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-em-chat-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  stateRoot = runInit(repo).stateRoot;
  store = StateStore.open(stateRoot);
  bus = new Bus(store, stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('EmChatService', () => {
  test('files the human line on the em inbox, streams the reply, and appends it to the thread', async () => {
    const resident = fakeResident(['TKT-1001 is in review, ', 'TKT-1002 is unassigned.']);
    const chat = new EmChatService({ store, bus, repoRoot: repo, resident });
    const sink = collector();

    const result = await chat.send({ body: 'what is left on all tickets' }, sink.hooks);
    expect(result.streaming).toBe(true);
    expect(result.message.to).toEqual(['em']);
    expect(bus.poll('em').some((m) => m.body === 'what is left on all tickets')).toBe(true);

    await settle(sink.ends);
    expect(sink.deltas.map((d) => d.text)).toEqual([
      'TKT-1001 is in review, ',
      'TKT-1002 is unassigned.',
    ]);
    // Every frame carries the id the stored reply ends up with, so the panel
    // never renders the streamed and the reloaded copy as two lines.
    expect(new Set(sink.deltas.map((d) => d.id))).toEqual(new Set([result.replyId as string]));
    expect(sink.ends).toEqual([{ id: result.replyId as string }]);

    // The thread is the bus, and it reads back in order after a "reload".
    const history = chat.history();
    expect(history.map((e) => [e.from, e.body])).toEqual([
      ['human', 'what is left on all tickets'],
      ['em', 'TKT-1001 is in review, TKT-1002 is unassigned.'],
    ]);
    expect(history[1]?.id).toBe(result.replyId as string);
  });

  test('history survives the EM polling (and acking) its inbox', async () => {
    const chat = new EmChatService({
      store,
      bus,
      repoRoot: repo,
      resident: fakeResident(['ack']),
    });
    const sink = collector();
    const result = await chat.send({ body: 'steer: pause TKT-1003' }, sink.hooks);
    await settle(sink.ends);

    await bus.ack('em', result.message.id);
    expect(bus.poll('em')).toHaveLength(0);
    // Acked messages move to `done/` — the thread must still read them, or a
    // reload would lose every line the EM has already picked up.
    expect(chat.history().map((e) => e.from)).toEqual(['human', 'em']);
  });

  test('an over-cap reply goes to a raw file with a pointer, and the thread re-hydrates it', async () => {
    const long = 'x'.repeat(MESSAGE_BODY_MAX_CHARS * 2);
    const chat = new EmChatService({ store, bus, repoRoot: repo, resident: fakeResident([long]) });
    const sink = collector();
    await chat.send({ body: 'give me everything' }, sink.hooks);
    await settle(sink.ends);

    const reply = chat.history().find((e) => e.from === 'em');
    expect(reply?.ref).toMatch(/^em-chat\//);
    // On the bus the body is capped with a pointer; the panel sees the full text.
    const stored = bus.poll('human').find((m) => m.from === 'em');
    expect(stored?.body.length).toBeLessThanOrEqual(MESSAGE_BODY_MAX_CHARS);
    expect(stored?.body).toContain('full reply: em-chat/');
    expect(reply?.body).toBe(long);

    const raw = join(repo, '.agile-daemon-cache', 'raw', 'em-chat', `${reply?.id}.md`);
    expect(existsSync(raw)).toBe(true);
    expect(readFileSync(raw, 'utf8')).toBe(long);
  });

  test('a failed turn still lands an answer on the thread and reports the error', async () => {
    const boom = (): Error => new Error('vendor exploded');
    const resident = {
      prompt() {
        return {
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(boom()) }),
          done: Promise.reject(boom()),
        };
      },
    };
    // The rejected `done` is handled by the relay; nothing else awaits it.
    const chat = new EmChatService({ store, bus, repoRoot: repo, resident });
    const sink = collector();
    await chat.send({ body: 'hello?' }, sink.hooks);
    await settle(sink.ends);
    expect(sink.ends[0]?.error).toContain('vendor exploded');
    expect(chat.history().find((e) => e.from === 'em')?.body).toContain('could not answer');
  });

  test('without a resident EM the human line still lands on the bus, with a reason', async () => {
    const chat = new EmChatService({ store, bus, repoRoot: repo });
    const sink = collector();
    const result = await chat.send({ body: 'anyone there?' }, sink.hooks);
    expect(result.streaming).toBe(false);
    expect(result.reason).toContain('no resident EM');
    expect(bus.poll('em').some((m) => m.body === 'anyone there?')).toBe(true);
  });

  test('the prompt carries the daemon-injected attention queue', async () => {
    const gates = new GateService(store);
    const questions = new QuestionService(store);
    const hil = await gates.request('unblock', {
      policy: { gates: { unblock: 'human' }, breaker_signals: [] },
      hilKind: 'unblock',
      summary: 'eng-0001 wants to run `git push origin main`',
    });
    const question = await questions.raise({ raised_by: 'human', text: 'ship Friday or Monday?' });

    const resident = fakeResident(['ok']);
    const chat = new EmChatService({ store, bus, repoRoot: repo, resident, gates, questions });
    await chat.send({ body: 'what is left on all tickets' }, collector().hooks);
    const prompt = resident.prompts[0] ?? '';
    expect(prompt).toContain(hil.id);
    expect(prompt).toContain('git push origin main');
    expect(prompt).toContain(question.id);
    expect(prompt).toContain('what is left on all tickets');
  });
});

describe('renderReplyBody / renderAttentionQueue', () => {
  test('a short reply is the body verbatim, with no refs and no file', () => {
    expect(renderReplyBody(repo, 'M-1', '  all green  ')).toEqual({ body: 'all green', refs: [] });
    expect(existsSync(join(repo, '.agile-daemon-cache', 'raw', 'em-chat'))).toBe(false);
  });

  test('an empty attention queue says so rather than emitting a bare header', () => {
    expect(renderAttentionQueue()).toBe('Attention queue: empty.');
  });
});
