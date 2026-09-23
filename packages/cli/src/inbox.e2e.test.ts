/**
 * T121 acceptance, end to end: an agent question on a stream **with no
 * repo** shows in `agile inbox` with its stream path, and `agile answer`
 * writes the thread entry, flips the stream statuses and reaches the
 * waiting session. Real in-process daemon, real unix socket, temp
 * `AGILE_HOME`; no vendor, no network, no git.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxItem, Question, Stream, ThreadEntry } from '@agile-agents/shared';
import { ulid } from '@agile-agents/shared';
import { runCli } from './index';
import { type TestDaemon, startTestDaemon } from './test-support';

let daemon: TestDaemon;

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(String(msg));
  try {
    const code = await runCli(argv, daemon.repo);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

async function newStream(title: string, extra: string[] = []): Promise<Stream> {
  const result = await cli([
    'stream',
    'new',
    '--title',
    title,
    '--goal',
    `goal: ${title}`,
    ...extra,
    '--json',
  ]);
  expect(result.code).toBe(0);
  return JSON.parse(result.out) as Stream;
}

beforeEach(async () => {
  daemon = await startTestDaemon('agile-inbox-e2e-');
});

afterEach(async () => {
  await daemon.cleanup();
});

describe('agile inbox / agile answer against a daemon on a temp AGILE_HOME', () => {
  test('a question on a repo-less stream reaches the inbox and the answer reaches the session', async () => {
    const root = await newStream('ledger-lite');
    const child = await newStream('parser', ['--parent', root.id]);
    // Neither stream has a repo, so nothing anywhere gained a worktree.
    expect(existsSync(join(daemon.home, '.worktrees'))).toBe(false);

    const empty = await cli(['inbox']);
    expect(empty.out).toContain('(empty)');

    // The agent asks — through the service, the path T130's MCP `ask` verb
    // will take (the RPC edge is the human's).
    const session = ulid();
    const question: Question = await daemon.questionService.raise({
      stream: child.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      session,
      text: 'comma or semicolon for the CSV dialect?',
    });
    // The record lives in the home, not on the bus.
    expect(existsSync(join(daemon.home, 'questions', `${question.id}.yaml`))).toBe(true);

    const listed = await cli(['inbox']);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('question');
    expect(listed.out).toContain('ledger-lite / parser');
    expect(listed.out).toContain('comma or semicolon');
    expect(listed.out).toContain(question.id);
    // T128: the age column is `age (ts)` — relative age plus the ISO time.
    const header = listed.out
      .split('\n')[0]
      ?.trimEnd()
      .split(/\s{2,}/);
    expect(header).toEqual(['kind', 'stream', 'age (ts)', 'context', 'id']);
    expect(listed.out).toContain(`(${question.raised_at})`);

    const asJson = await cli(['inbox', '--json']);
    const items = (JSON.parse(asJson.out) as { items: InboxItem[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.stream_path).toEqual(['ledger-lite', 'parser']);
    expect(items[0]?.ref).toBe(`questions/${question.id}.yaml`);

    // The asking stream is the one waiting on the human.
    expect(daemon.streamService.get(child.id).agent.status).toBe('question');
    expect(daemon.streamService.get(child.id).human.status).toBe('waiting_on_you');

    const answered = await cli([
      'answer',
      question.id,
      'semicolon',
      '—',
      'the',
      'export',
      'uses it',
    ]);
    expect(answered.code).toBe(0);
    expect(answered.out).toContain('answered');

    const after = daemon.streamService.get(child.id);
    // T130: nothing is attached to this stream, so answering hands it back
    // to `idle` rather than claiming an agent is at work on it.
    expect(after.agent.status).toBe('idle');
    expect(after.human.status).toBe('open');

    const entries: ThreadEntry[] = daemon.streamService.readThread(child.id).entries;
    expect(entries.find((e) => e.kind === 'question')?.by).toBe(`agent:${session}`);
    const answer = entries.find((e) => e.kind === 'answer');
    expect(answer?.by).toBe('human');
    expect(answer?.body).toBe('semicolon — the export uses it');

    // T137: delivery is a prompt into the live session, and there is none
    // here — so nothing is written to a mailbox, and the thread carries the
    // answer for the next attach's brief.
    expect(existsSync(join(daemon.home, 'bus', 'inbox', '01ARZ3NDEKTSV4RRFFQ69GE001'))).toBe(false);
    expect(existsSync(join(daemon.home, 'bus', 'inbox', session))).toBe(false);

    // Answered: out of the inbox for good.
    expect((await cli(['inbox'])).out).toContain('(empty)');
  });

  /**
   * T136 (QA rough edges 4 and 7): the context cell is elided at a word
   * boundary, and a `done` stream's item names both exits — landing and
   * closing — so an item you decide not to land still has a way out.
   */
  test('a long context is cut at a word boundary and a done item says what clears it', async () => {
    const stream = await newStream('ledger-lite');
    // Long enough to be cut, with a word boundary near the 200-char budget
    // so a mid-word slice would be visible.
    const words = 'dialect '.repeat(40);
    const question: Question = await daemon.questionService.raise({
      stream: stream.id,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: `${words}end`,
    });
    const listed = await cli(['inbox', '--json']);
    const items = (JSON.parse(listed.out) as { items: InboxItem[] }).items;
    const cut = items.find((i) => i.id === question.id)?.context ?? '';
    expect(cut.endsWith('…')).toBe(true);
    // Whole words only: no half word before the ellipsis.
    expect(cut).toMatch(/(^|\s)dialect…$/);
    expect(cut.length).toBeLessThanOrEqual(200);

    // The `done` item names both exits (§3.2's one line of context). A
    // fresh stream: raising a question above flipped this one's human half
    // to `waiting_on_you`, and only an `open` human half is a stream item.
    const finished = await newStream('parser');
    await daemon.streamService.update('daemon', finished.id, { agent: { status: 'done' } });
    const done = await cli(['inbox']);
    expect(done.out).toContain('worker finished — land or close the stream');
  });

  test('a routed tool call shows as a gate card and `agile answer <HIL-id> yes` decides it (T138)', async () => {
    const root = await newStream('ledger-lite');

    // The gate the hook's route band raises (`hook/route-band.ts`), created
    // here through the same service the hook calls.
    const gate = await daemon.gateService.request('classifier_review', {
      policy: {
        gates: { land: 'human', rule_accept: 'human', classifier_review: 'human' },
        breaker_signals: [],
      },
      stream: root.id,
      summary: 'editing a dependency manifest/lockfile is never automatic',
      call: { tool: 'Edit', path: '/tmp/wt/package.json', fingerprint: '0123456789abcdef' },
    });

    const listed = await cli(['inbox']);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('gate');
    expect(listed.out).toContain('ledger-lite');
    // The card shows the call, so the decision needs nothing else (§3.2).
    expect(listed.out).toContain('edit /tmp/wt/package.json');
    expect(listed.out).toContain('dependency manifest');
    expect(listed.out).toContain(gate.id);

    const answered = await cli(['answer', gate.id, 'yes', 'pin', 'it', 'to', '1.2.3']);
    expect(answered.code).toBe(0);
    expect(answered.out).toContain('approve');
    expect(daemon.gateService.get(gate.id).note).toBe('pin it to 1.2.3');

    // Decided: out of the inbox.
    expect((await cli(['inbox'])).out).toContain('(empty)');
  });

  test('stale mail from a previous daemon run never becomes an inbox item', async () => {
    await newStream('ledger-lite');
    const dir = join(daemon.home, 'bus', 'inbox', 'human');
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
    const listed = await cli(['inbox']);
    expect(listed.out).toContain('(empty)');
    expect(listed.out).not.toContain('stale question');
  });
});
