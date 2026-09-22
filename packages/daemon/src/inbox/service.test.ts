/**
 * T121 acceptance: the inbox is built from records, never from the bus
 * (cockpit design §1.4, §3). The stale-question defect of the 2026-09-11
 * live run is the last test in this file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Stream, ulid } from '@agile-agents/shared';
import { GateService } from '../gates/service';
import { runInit } from '../init';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { InboxService } from './service';

let repo: string;
let home: string;
let store: StateStore;
let streams: StreamService;
let questions: QuestionService;
let gates: GateService;
let inbox: InboxService;
let root: Stream;
let child: Stream;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-inbox-'));
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
  gates = new GateService(store);
  inbox = new InboxService({ streams, questions, gates });
  // Neither stream has a repo (§1.3: a stream with no repo is fully usable).
  root = await streams.create('human', { title: 'ledger-lite', goal: 'import CSVs' });
  child = await streams.create('human', {
    title: 'parser',
    goal: 'pick the dialect',
    parent: root.id,
  });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('InboxService.list', () => {
  test('a question on a stream with no repo shows with its stream path and a one-line context', async () => {
    const q = await questions.raise({
      stream: child.id,
      raised_by: 'eng-1',
      text: 'comma or semicolon?',
    });
    const items = inbox.list();
    const item = items.find((i) => i.id === q.id);
    expect(item?.kind).toBe('question');
    expect(item?.stream).toBe(child.id);
    expect(item?.stream_path).toEqual(['ledger-lite', 'parser']);
    expect(item?.context).toBe('comma or semicolon?');
    expect(item?.ref).toBe(`questions/${q.id}.yaml`);
  });

  test('T161: a clipped context carries the full text as detail; a short one carries none', async () => {
    const text = `${'which delimiter wins in the EU exports, '.repeat(8)}TAIL?`;
    const long = await questions.raise({ stream: child.id, raised_by: 'eng-1', text });
    const short = await questions.raise({ stream: child.id, raised_by: 'eng-1', text: 'ok?' });
    const items = inbox.list();
    const longItem = items.find((i) => i.id === long.id);
    expect(longItem?.context.length).toBeLessThanOrEqual(200);
    expect(longItem?.context).not.toContain('TAIL?');
    expect(longItem?.detail).toBe(text.trim());
    expect(items.find((i) => i.id === short.id)?.detail).toBeUndefined();
  });

  test('a pending gate shows; a resolved one does not', async () => {
    const gate = await gates.request('land', {
      policy: { gates: { land: 'human' }, breaker_signals: [] },
      stream: root.id,
      summary: 'merge parser into main',
    });
    expect(inbox.list().some((i) => i.id === gate.id && i.kind === 'gate')).toBe(true);
    await gates.respond(gate.id, 'approve', 'human');
    expect(inbox.list().some((i) => i.id === gate.id)).toBe(false);
  });

  test('blocked and done streams with human.status open are items; landed ones are not', async () => {
    await streams.update('daemon', child.id, { agent: { status: 'done' } });
    expect(inbox.list().find((i) => i.stream === child.id)?.kind).toBe('done');

    await streams.update('daemon', child.id, { agent: { status: 'blocked' } });
    expect(inbox.list().find((i) => i.stream === child.id)?.kind).toBe('blocked');

    await streams.update('human', child.id, { human: { status: 'landed' } });
    expect(inbox.list().some((i) => i.stream === child.id)).toBe(false);
  });

  test('an answered question leaves the inbox', async () => {
    const q = await questions.raise({ stream: root.id, raised_by: 'eng-1', text: 'which one?' });
    expect(inbox.list().some((i) => i.id === q.id)).toBe(true);
    await questions.answer(q.id, { answer: 'the first', by: 'human' });
    expect(inbox.list().some((i) => i.id === q.id)).toBe(false);
  });

  test('oldest first, across every stream', async () => {
    const first = await questions.raise({ stream: root.id, raised_by: 'eng-1', text: 'first' });
    const second = await questions.raise({ stream: child.id, raised_by: 'eng-1', text: 'second' });
    const ids = inbox.list().map((i) => i.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
  });

  /**
   * The 2026-09-11 defect: the inbox was a bus drain, so questions from a
   * previous daemon run reappeared. Questions are records with a status
   * now, and there is no drain at start — a leftover message in the home's
   * bus inboxes is invisible here.
   */
  test('stale mail from a previous daemon run cannot appear as a question or an item', () => {
    const dir = join(home, 'bus', 'inbox', 'human');
    mkdirSync(dir, { recursive: true });
    const id = ulid();
    writeFileSync(
      join(dir, `${id}.yaml`),
      [
        `id: ${id}`,
        `ts: '${new Date(0).toISOString()}'`,
        'from: eng-1',
        'to:',
        '  - human',
        'kind: hil_request',
        'priority: urgent',
        "body: 'stale question from the previous run'",
        'refs: []',
        'requires_ack: true',
        `deadline: '${new Date().toISOString()}'`,
        'hil_kind: classifier_review',
        '',
      ].join('\n'),
    );
    expect(questions.list()).toEqual([]);
    expect(inbox.list()).toEqual([]);
  });
});
