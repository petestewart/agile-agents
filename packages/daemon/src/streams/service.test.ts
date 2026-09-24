/**
 * T120: the stream service against a real temp state home — no git, no
 * vendor, no network.
 *
 * The acceptance criterion "a stream without a repo is fully usable and
 * never touches git" is asserted structurally: the home used here is not a
 * git repository at all (no `git init`), and the test asserts no worktree
 * directory appears anywhere under it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamCycleError, THREAD_BODY_MAX_CHARS, ulid } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from './service';

let home: string;
let store: StateStore;
let streams: StreamService;

beforeEach(() => {
  // Deliberately NOT a git repo: nothing in this ticket may shell out to git.
  home = mkdtempSync(join(tmpdir(), 'agile-streams-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function newStream(title = 'Fix the flaky test', extra: Record<string, unknown> = {}) {
  return streams.create('human', { title, goal: 'make it deterministic', ...extra });
}

describe('create', () => {
  test('mints id/created_at and the §2.3 starting statuses', async () => {
    const stream = await newStream();
    expect(stream.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(stream.agent.status).toBe('idle');
    expect(stream.human.status).toBe('open');
    expect(stream.sessions).toEqual([]);
    // branch/worktree appear on first attach (T130), never on create.
    expect(stream.branch).toBeUndefined();
    expect(stream.worktree).toBeUndefined();
    expect(existsSync(join(home, 'streams', `${stream.id}.yaml`))).toBe(true);
  });

  test('rejects a caller-supplied id, status or session (daemon-owned fields)', async () => {
    await expect(streams.create('human', { title: 't', goal: 'g', id: ulid() })).rejects.toThrow(
      /StreamCreateInput/,
    );
    await expect(
      streams.create('human', { title: 't', goal: 'g', human: { status: 'landed' } }),
    ).rejects.toThrow(/StreamCreateInput/);
  });

  test('a repo must be registered in repos.yaml, and the error names it', async () => {
    await expect(newStream('with repo', { repo: 'nope' })).rejects.toThrow(
      /unknown repo: nope .*none registered/,
    );
    await store.addRepo('alpha', { path: home });
    const stream = await newStream('with repo', { repo: 'alpha' });
    expect(stream.repo).toBe('alpha');
  });

  test('an unknown parent is refused', async () => {
    await expect(newStream('child', { parent: ulid() })).rejects.toThrow(/unknown parent stream/);
  });

  test('emits stream_created plus the opening thread event', async () => {
    const stream = await newStream();
    const kinds = store.listEvents().map((e) => e.kind);
    expect(kinds).toContain('stream_created');
    expect(kinds).toContain('thread_appended');
    const created = store.listEvents().find((e) => e.kind === 'stream_created');
    // T123: the stream id is the event's own `stream` scope (what
    // `agile tail --stream` filters on); `data` carries the status pair.
    expect(created?.stream).toBe(stream.id);
    expect(created?.data).toMatchObject({
      agent_status: 'idle',
      human_status: 'open',
      archived: false,
    });
  });
});

describe('list and tree', () => {
  test('returns parent/child structure', async () => {
    const root = await newStream('root');
    const child = await streams.create('human', {
      title: 'child',
      goal: 'g',
      parent: root.id,
    });
    const grandchild = await streams.create('human', {
      title: 'grandchild',
      goal: 'g',
      parent: child.id,
    });

    const tree = streams.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0]?.stream.id).toBe(root.id);
    expect(tree[0]?.children[0]?.stream.id).toBe(child.id);
    expect(tree[0]?.children[0]?.children[0]?.stream.id).toBe(grandchild.id);
  });

  test('archive hides a stream from list unless include_archived', async () => {
    const a = await newStream('a');
    await newStream('b');
    await streams.archive('human', a.id);

    expect(streams.list().map((s) => s.title)).toEqual(['b']);
    expect(
      streams
        .list({ include_archived: true })
        .map((s) => s.title)
        .sort(),
    ).toEqual(['a', 'b']);
    // Nothing moved on disk.
    expect(existsSync(join(home, 'streams', `${a.id}.yaml`))).toBe(true);
    expect(store.getStream(a.id).archived).toBe(true);
    expect(store.listEvents().some((e) => e.kind === 'stream_archived')).toBe(true);
  });

  test('a live child of an archived parent surfaces at the root, not hidden with it', async () => {
    const parent = await newStream('parent');
    const child = await streams.create('human', { title: 'child', goal: 'g', parent: parent.id });
    await streams.archive('human', parent.id);
    const tree = streams.tree();
    expect(tree.map((n) => n.stream.id)).toEqual([child.id]);
  });
});

describe('principal checks (design §2.2, T110)', () => {
  test('a human principal may not write agent.*', async () => {
    const stream = await newStream();
    await expect(
      streams.update('human', stream.id, { agent: { status: 'working' } }),
    ).rejects.toThrow(/a human principal may not change agent/);
  });

  test('an agent principal may not write human.*', async () => {
    const stream = await newStream();
    await expect(
      streams.update('agent', stream.id, { human: { status: 'landed' } }),
    ).rejects.toThrow(/an agent principal may not change human/);
  });

  test('an agent principal may write agent.*, and daemon may write both', async () => {
    const stream = await newStream();
    const working = await streams.update('agent', stream.id, {
      agent: { status: 'working', progress: 'reading the test' },
    });
    expect(working.agent.status).toBe('working');
    expect(working.agent.progress).toBe('reading the test');

    const landed = await streams.update('daemon', stream.id, {
      agent: { status: 'done' },
      human: { status: 'landed' },
    });
    expect(landed.agent.status).toBe('done');
    expect(landed.human.status).toBe('landed');
  });

  test('close is a human-half write and emits stream_closed', async () => {
    const stream = await newStream();
    const closed = await streams.close('human', stream.id, 'not worth doing');
    expect(closed.human.status).toBe('closed');
    expect(closed.human.note).toBe('not worth doing');
    expect(closed.agent.status).toBe('idle');
    expect(store.listEvents().some((e) => e.kind === 'stream_closed')).toBe(true);
  });

  test('close records its note as one thread line and one stream_closed event', async () => {
    const stream = await newStream();
    const before = streams.readThread(stream.id).total;
    await streams.close('human', stream.id, 'not worth doing');
    const thread = streams.readThread(stream.id);
    expect(thread.total).toBe(before + 1);
    const last = thread.entries[thread.entries.length - 1];
    expect(last?.by).toBe('human');
    expect(last?.kind).toBe('line');
    expect(last?.body).toBe('closed: not worth doing');
    expect(store.listEvents().filter((e) => e.kind === 'stream_closed')).toHaveLength(1);
  });

  test('close without a note leaves the thread alone', async () => {
    const stream = await newStream();
    const before = streams.readThread(stream.id).total;
    const closed = await streams.close('human', stream.id);
    expect(closed.human.status).toBe('closed');
    expect(streams.readThread(stream.id).total).toBe(before);
  });

  test('a parent cycle is refused by the store, not by caller discipline', async () => {
    const a = await newStream('a');
    const b = await streams.create('human', { title: 'b', goal: 'g', parent: a.id });
    await expect(streams.update('human', a.id, { parent: b.id })).rejects.toThrow(StreamCycleError);
    // The message names the chain it walked, with no `undefined`/`null` in it
    // (T126, QA rough edge 1).
    const cycle = (await streams.update('human', a.id, { parent: b.id }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )) as Error;
    expect(cycle.message).toContain(`${a.id} -> ${b.id} -> ${a.id}`);
    expect(cycle.message).not.toContain('undefined');
    expect(cycle.message).not.toContain('null');
    await expect(streams.update('human', a.id, { parent: a.id })).rejects.toThrow(
      /cannot be its own parent/,
    );
  });
});

describe('thread', () => {
  test('appends and reads back, paged by line index', async () => {
    const stream = await newStream();
    for (let i = 0; i < 5; i++) {
      await streams.appendThread('human', stream.id, { kind: 'line', body: `line ${i}` });
    }
    const all = streams.readThread(stream.id);
    // 1 creation event + 5 lines.
    expect(all.total).toBe(6);
    expect(all.entries).toHaveLength(6);
    expect(all.next).toBeUndefined();

    const page = streams.readThread(stream.id, { limit: 2 });
    expect(page.entries.map((e) => e.body)).toEqual([`stream created: ${stream.title}`, 'line 0']);
    expect(page.next).toBe(1);

    const second = streams.readThread(stream.id, { after: page.next, limit: 2 });
    expect(second.from).toBe(2);
    expect(second.entries.map((e) => e.body)).toEqual(['line 1', 'line 2']);
  });

  test('an agent author carries its session id; a bare agent principal cannot write', async () => {
    const stream = await newStream();
    const session = ulid();
    const entry = await streams.appendThread(
      'agent',
      stream.id,
      { kind: 'finding', body: 'null deref', ref: 'src/a.ts:12' },
      session,
    );
    expect(entry.by).toBe(`agent:${session}`);
    expect(entry.ref).toBe('src/a.ts:12');
    await expect(
      streams.appendThread('agent', stream.id, { kind: 'line', body: 'x' }),
    ).rejects.toThrow(/must name its session id/);
  });

  test('a body over the cap is rejected with the cap in the message', async () => {
    const stream = await newStream();
    await expect(
      streams.appendThread('human', stream.id, { kind: 'line', body: 'x'.repeat(801) }),
    ).rejects.toThrow(new RegExp(`cap is ${THREAD_BODY_MAX_CHARS}`));
  });

  test('a corrupt thread line is refused with the path and the line number', async () => {
    const stream = await newStream();
    await streams.appendThread('human', stream.id, { kind: 'line', body: 'ok' });
    const path = join(home, 'threads', `${stream.id}.jsonl`);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"not":"an entry"}\n`);
    expect(() => streams.readThread(stream.id)).toThrow(
      new RegExp(`corrupt thread file ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:3`),
    );
  });

  test('an unknown stream is a not-found, not an empty thread', async () => {
    expect(() => streams.readThread(ulid())).toThrow(/Stream/);
    await expect(
      streams.appendThread('human', ulid(), { kind: 'line', body: 'x' }),
    ).rejects.toThrow(/Stream/);
  });
});

describe('a stream without a repo never touches git', () => {
  test('the whole flow runs in a home with no repos and creates no worktree', async () => {
    expect(store.getRepos()).toEqual({});
    const stream = await newStream('planning only');
    await streams.appendThread('human', stream.id, { kind: 'question', body: 'which approach?' });
    await streams.update('agent', stream.id, { agent: { status: 'question' } });
    await streams.update('human', stream.id, { human: { status: 'waiting_on_you' } });
    await streams.close('human', stream.id);
    await streams.archive('human', stream.id);

    const record = store.getStream(stream.id);
    expect(record.repo).toBeUndefined();
    expect(record.branch).toBeUndefined();
    expect(record.worktree).toBeUndefined();

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? [e.name, ...walk(join(dir, e.name))] : [e.name],
      );
    const names = walk(home);
    expect(names).not.toContain('.worktrees');
    expect(names).not.toContain('.git');
  });
});
