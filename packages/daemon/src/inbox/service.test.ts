/**
 * T121 acceptance: the inbox is built from records, never from the bus
 * (cockpit design §1.4, §3). The stale-question defect of the 2026-09-11
 * live run is the last test in this file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Stream, ulid, validateInboxItem } from '@agile-agents/shared';
import { GateService } from '../gates/service';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
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
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
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
    const long = await questions.raise({
      stream: child.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text,
    });
    const short = await questions.raise({
      stream: child.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'ok?',
    });
    const items = inbox.list();
    const longItem = items.find((i) => i.id === long.id);
    expect(longItem?.context.length).toBeLessThanOrEqual(200);
    expect(longItem?.context).not.toContain('TAIL?');
    expect(longItem?.detail).toBe(text.trim());
    expect(items.find((i) => i.id === short.id)?.detail).toBeUndefined();
  });

  test("T361: a question's choices ride on its card when they fit one", async () => {
    const q = await questions.raise({
      stream: child.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'comma or semicolon?',
      options: ['comma', 'semicolon'],
    });
    // Over RPC a question may offer anything; a card shows at most six short ones.
    const many = await questions.raise({
      stream: child.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'which letter?',
      options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    const items = inbox.list();
    expect(items.find((i) => i.id === q.id)?.options).toEqual(['comma', 'semicolon']);
    expect(items.find((i) => i.id === many.id)?.options).toBeUndefined();
    expect(items.every((i) => validateInboxItem(i).id === i.id)).toBe(true);
  });

  test("T361: a deleted node's question, gate and done item leave the inbox, and come back on restore", async () => {
    const q = await questions.raise({
      stream: child.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'comma or semicolon?',
    });
    const gate = await gates.request('land', {
      policy: { gates: { land: 'human' }, breaker_signals: [] },
      stream: child.id,
      summary: 'merge parser into main',
    });
    const other = await streams.create('human', { title: 'writer', goal: 'g', parent: root.id });
    await streams.update('daemon', other.id, { agent: { status: 'done' } });
    const ids = () => inbox.list().map((i) => i.id);
    expect(ids()).toEqual(expect.arrayContaining([q.id, gate.id, other.id]));

    await streams.archiveTree('human', child.id);
    await streams.archiveTree('human', other.id);
    expect(ids()).not.toContain(q.id);
    expect(ids()).not.toContain(gate.id);
    expect(ids()).not.toContain(other.id);

    await streams.unarchiveTree('human', child.id);
    expect(ids()).toEqual(expect.arrayContaining([q.id, gate.id]));
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

  test('T371: with no progress line, a done or blocked card says what to do, in the cockpit’s words', async () => {
    await streams.update('daemon', child.id, { agent: { status: 'done' } });
    const done = inbox.list().find((i) => i.stream === child.id);
    expect(done?.context).toBe(
      'The agent finished. Look over the changes, then merge — or close the node if you won’t.',
    );
    await streams.update('daemon', child.id, { agent: { status: 'blocked' } });
    const blocked = inbox.list().find((i) => i.stream === child.id);
    expect(blocked?.context).toBe(
      'The agent is stuck and needs a hand. Open the node to see where it stopped.',
    );
    // The agent's own last line wins over the stock one.
    await streams.update('agent', child.id, { agent: { progress: 'need the API key' } });
    expect(inbox.list().find((i) => i.stream === child.id)?.context).toBe('need the API key');
  });

  test('T336: a coordinating node whose coordinator finished is not "ready to land"', async () => {
    const grandchild = await streams.create('human', {
      title: 'api part',
      goal: 'g',
      parent: child.id,
    });
    await streams.update('daemon', child.id, { agent: { status: 'done' } });
    await streams.update('daemon', root.id, { agent: { status: 'done' } });
    expect(inbox.list().some((i) => i.stream === child.id)).toBe(false);
    expect(inbox.list().some((i) => i.stream === root.id)).toBe(false);
    // Blocked still needs you; the part itself still lands.
    await streams.update('daemon', child.id, { agent: { status: 'blocked' } });
    await streams.update('daemon', grandchild.id, { agent: { status: 'done' } });
    expect(inbox.list().find((i) => i.stream === child.id)?.kind).toBe('blocked');
    expect(inbox.list().find((i) => i.stream === grandchild.id)?.kind).toBe('done');
  });

  test('T336: a project root\'s coordinator finishing is not "ready to land"', async () => {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    await streams.update('daemon', project.root, { agent: { status: 'done' } });
    expect(inbox.list().some((i) => i.stream === project.root)).toBe(false);
  });

  test('T341: a conversation that answered is not "ready to land" (it has no branch)', async () => {
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const talk = await streams.create('human', {
      title: 'Cents check',
      goal: 'how are amounts stored?',
      project: project.id,
    });
    await streams.update('daemon', talk.id, { agent: { status: 'done' } });
    expect(inbox.list().some((i) => i.stream === talk.id)).toBe(false);
    // Blocked still needs you.
    await streams.update('daemon', talk.id, { agent: { status: 'blocked' } });
    expect(inbox.list().find((i) => i.stream === talk.id)?.kind).toBe('blocked');
  });

  test('T341: a finished node whose PR is open is not "ready to land" (it merges on GitHub)', async () => {
    const at = new Date().toISOString();
    await streams.update('daemon', child.id, {
      agent: { status: 'done' },
      delivery_state: {
        mode: 'pr',
        status: 'pr_open',
        at,
        pr: {
          number: 1,
          url: 'https://github.com/o/r/pull/1',
          head: 'stream/x',
          base: 'main',
          state: 'open',
          draft: false,
          review: 'none',
          checks: 'pending',
          mergeable: 'clean',
          auto_merge: 'enabled',
          last_seen: {},
          polled_at: at,
        },
      },
    });
    expect(inbox.list().some((i) => i.stream === child.id)).toBe(false);
  });

  test('an answered question leaves the inbox', async () => {
    const q = await questions.raise({
      stream: root.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'which one?',
    });
    expect(inbox.list().some((i) => i.id === q.id)).toBe(true);
    await questions.answer(q.id, { answer: 'the first', by: 'human' });
    expect(inbox.list().some((i) => i.id === q.id)).toBe(false);
  });

  test('oldest first, across every stream', async () => {
    const first = await questions.raise({
      stream: root.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'first',
    });
    const second = await questions.raise({
      stream: child.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'second',
    });
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
