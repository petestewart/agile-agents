import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StepIndex } from './steps';

const NODE = '01ARZ3NDEKTSV4RRFFQ69GE001';
const OTHER = '01ARZ3NDEKTSV4RRFFQ69GE002';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agile-feed-steps-'));
  path = join(dir, 'events.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

let clock = 0;
/** A `tool_call` event line as the runner writes it (`agent` is the session). */
function call(
  toolCallId: string,
  fields: { kind?: string; title?: string; status?: string } = {},
  opts: { node?: string; session?: string } = {},
): string {
  clock += 1;
  return `${JSON.stringify({
    ts: new Date(Date.UTC(2026, 8, 26, 12, 0, clock)).toISOString(),
    kind: 'tool_call',
    agent: opts.session ?? 'S-1',
    data: { stream: opts.node ?? NODE, toolCallId, ...fields },
  })}\n`;
}

function other(kind: string): string {
  return `${JSON.stringify({ ts: new Date().toISOString(), kind, stream: NODE, data: { kind: 'read' } })}\n`;
}

describe('StepIndex', () => {
  test('one step per call, the latest status and title, newest first', () => {
    writeFileSync(
      path,
      [
        other('thread_appended'),
        call('t1', { kind: 'read', title: 'Read src/a.ts', status: 'pending' }),
        call('t1', { status: 'in_progress' }),
        call('t2', { kind: 'execute', title: 'Terminal', status: 'pending' }),
        call('t1', { status: 'completed' }),
        call('t2', { title: '`bun test`', status: 'failed' }),
        other('stream_updated'),
      ].join(''),
    );
    const index = new StepIndex(path);
    const page = index.stepsFor(NODE);
    expect(page.total).toBe(2);
    expect(page.steps.map((s) => [s.id, s.kind, s.title, s.status])).toEqual([
      ['t2', 'execute', '`bun test`', 'failed'],
      ['t1', 'read', 'Read src/a.ts', 'completed'],
    ]);
    // `ts` is when the call was first seen; `session` the one that made it.
    const t1 = page.steps[1];
    expect(t1?.ts).toBe('2026-09-26T12:00:01.000Z');
    expect(t1?.session).toBe('S-1');
    expect(index.stepsFor(OTHER)).toEqual({ steps: [], total: 0 });
  });

  test('later reads fold in only what was appended, a partial line waiting for its tail', () => {
    writeFileSync(path, call('t1', { kind: 'read', title: 'Read a', status: 'pending' }));
    const index = new StepIndex(path);
    expect(index.stepsFor(NODE).steps.map((s) => s.status)).toEqual(['pending']);

    const update = call('t1', { status: 'completed' });
    const next = call('t2', { kind: 'edit', title: 'Edit b', status: 'pending' });
    appendFileSync(path, update + next.slice(0, 20));
    expect(index.stepsFor(NODE).steps.map((s) => [s.id, s.status])).toEqual([['t1', 'completed']]);
    appendFileSync(path, next.slice(20));
    expect(index.stepsFor(NODE).steps.map((s) => [s.id, s.status])).toEqual([
      ['t2', 'pending'],
      ['t1', 'completed'],
    ]);
  });

  test('keeps nodes and sessions apart; an update to an unknown call is dropped', () => {
    writeFileSync(
      path,
      [
        call('t1', { kind: 'read', title: 'Read a' }),
        call('t1', { kind: 'read', title: 'Read b' }, { session: 'S-2' }),
        call('t1', { kind: 'search', title: 'Find c' }, { node: OTHER }),
        call('ghost', { status: 'completed' }),
        'not json {"kind":"tool_call"\n',
      ].join(''),
    );
    const index = new StepIndex(path);
    expect(index.stepsFor(NODE).steps.map((s) => [s.session, s.title])).toEqual([
      ['S-2', 'Read b'],
      ['S-1', 'Read a'],
    ]);
    expect(index.stepsFor(OTHER).steps.map((s) => s.title)).toEqual(['Find c']);
  });

  test('keeps the newest steps per node and caps a read; total counts them all', () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(call(`t${i}`, { kind: 'read', title: `Read ${i}` }));
    writeFileSync(path, lines.join(''));
    const index = new StepIndex(path, 10);
    const page = index.stepsFor(NODE, 5);
    expect(page.total).toBe(40);
    expect(page.steps.map((s) => s.id)).toEqual(['t39', 't38', 't37', 't36', 't35']);
    expect(index.stepsFor(NODE, 100).steps.length).toBeLessThanOrEqual(13);
  });

  test('a missing log reads empty; a truncated one is read again from the top', () => {
    const index = new StepIndex(path);
    expect(index.stepsFor(NODE)).toEqual({ steps: [], total: 0 });
    writeFileSync(
      path,
      call('t1', { kind: 'read', title: 'Read a' }) + call('t2', { kind: 'read', title: 'Read b' }),
    );
    expect(index.stepsFor(NODE).total).toBe(2);
    writeFileSync(path, call('t9', { kind: 'edit', title: 'Edit z' }));
    expect(index.stepsFor(NODE).steps.map((s) => s.id)).toEqual(['t9']);
  });
});
