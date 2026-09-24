import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Event, ulid } from '@agile-agents/shared';
import {
  type NodeActivityRow,
  formatActivityRow,
  readNodeActivity,
  runDirectorTail,
  runTail,
  splitComplete,
} from './tail';

let dir: string;
let eventsPath: string;

const STREAM_A = '01J9AAAAAAAAAAAAAAAAAAAAAA';
const STREAM_B = '01J9BBBBBBBBBBBBBBBBBBBBBB';

function line(event: Partial<Event> & Pick<Event, 'kind'>): string {
  return `${JSON.stringify({ ts: new Date().toISOString(), data: {}, ...event })}\n`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agile-cli-tail-'));
  mkdirSync(join(dir, 'log'), { recursive: true });
  eventsPath = join(dir, 'log', 'events.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runTail (no --follow)', () => {
  test('prints every existing line, unfiltered', async () => {
    writeFileSync(
      eventsPath,
      line({ kind: 'stream_created', stream: STREAM_A }) + line({ kind: 'message', agent: 'em' }),
    );
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      const code = await runTail({ eventsPath, filters: {}, follow: false, json: false });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    expect(lines).toHaveLength(2);
  });

  test('filters by stream/kind/session', async () => {
    writeFileSync(
      eventsPath,
      line({ kind: 'stream_created', stream: STREAM_A }) +
        line({ kind: 'stream_created', stream: STREAM_B }) +
        line({ kind: 'message', agent: 'em' }),
    );
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await runTail({ eventsPath, filters: { stream: STREAM_A }, follow: false, json: true });
    } finally {
      console.log = original;
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).stream).toBe(STREAM_A);
  });

  test('filters by session', async () => {
    writeFileSync(
      eventsPath,
      line({ kind: 'tool_call', session: STREAM_A }) +
        line({ kind: 'tool_call', session: STREAM_B }),
    );
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await runTail({ eventsPath, filters: { session: STREAM_B }, follow: false, json: true });
    } finally {
      console.log = original;
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).session).toBe(STREAM_B);
  });

  test('a missing events file is not an error — nothing to print', async () => {
    const code = await runTail({
      eventsPath: join(dir, 'nope.jsonl'),
      filters: {},
      follow: false,
      json: false,
    });
    expect(code).toBe(0);
  });
});

describe('runTail --follow', () => {
  test('picks up lines appended after start, then stops on abort', async () => {
    writeFileSync(eventsPath, line({ kind: 'stream_created', stream: STREAM_A }));
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);

    const controller = new AbortController();
    const run = runTail({
      eventsPath,
      filters: {},
      follow: true,
      json: true,
      pollMs: 20,
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    appendFileSync(eventsPath, line({ kind: 'gate_raised' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();
    await run;
    console.log = original;

    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => JSON.parse(l).kind === 'gate_raised')).toBe(true);
  });

  test('a line appended in two chunks (torn across polls) is printed exactly once', async () => {
    writeFileSync(eventsPath, '');
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);

    const controller = new AbortController();
    const run = runTail({
      eventsPath,
      filters: {},
      follow: true,
      json: true,
      pollMs: 20,
      signal: controller.signal,
    });

    const full = line({ kind: 'gate_raised' });
    const splitAt = Math.floor(full.length / 2);

    // First chunk: no trailing newline — a poll landing here must not emit
    // or parse anything yet.
    await new Promise((resolve) => setTimeout(resolve, 40));
    appendFileSync(eventsPath, full.slice(0, splitAt));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(lines).toHaveLength(0);

    // Second chunk completes the line (including its trailing '\n').
    appendFileSync(eventsPath, full.slice(splitAt));
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();
    await run;
    console.log = original;

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).kind).toBe('gate_raised');
  });
});

describe('splitComplete', () => {
  test('a trailing newline yields all lines complete, empty carry', () => {
    expect(splitComplete('', 'a\nb\n')).toEqual({ complete: ['a', 'b'], carry: '' });
  });

  test('no trailing newline defers the last fragment as carry', () => {
    expect(splitComplete('', 'a\nb')).toEqual({ complete: ['a'], carry: 'b' });
  });

  test('a prior carry is prepended before splitting', () => {
    expect(splitComplete('a', 'b\nc\n')).toEqual({ complete: ['ab', 'c'], carry: '' });
  });

  test('an empty chunk with no carry yields nothing, empty carry', () => {
    expect(splitComplete('', '')).toEqual({ complete: [], carry: '' });
  });
});

describe('agile tail --node <id> --events (T245)', () => {
  test('joins the routed log and the node queue: reason, latest status, carrier', () => {
    const home = mkdtempSync(join(tmpdir(), 'agile-tail-node-'));
    try {
      const node = ulid();
      mkdirSync(join(home, 'events', 'queue'), { recursive: true });
      const event = {
        id: `E-${ulid()}`,
        at: '2026-09-24T10:00:00.000Z',
        type: 'main_changed',
        repo: 'api',
        payload: { repo: 'api', sha: 'b2', outcome: 'synced' },
        by: 'daemon',
        routing: [{ node, because: 'same_repo' }],
      };
      writeFileSync(join(home, 'events', 'log.jsonl'), `${JSON.stringify(event)}\n`);
      writeFileSync(
        join(home, 'events', 'queue', `${node}.jsonl`),
        `${JSON.stringify({ event: event.id, node, status: 'pending' })}\n${JSON.stringify({
          event: event.id,
          node,
          status: 'delivered',
          session: 'S-9',
        })}\n`,
      );
      const rows = readNodeActivity(home, node);
      expect(rows).toHaveLength(1);
      expect(formatActivityRow(rows[0] as NodeActivityRow)).toBe(
        `2026-09-24T10:00:00.000Z main_changed [api] because same repo · delivered in session S-9 (${event.id})`,
      );
      expect(readNodeActivity(home, ulid())).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('runDirectorTail (T300)', () => {
  test('prints the Director thread, one line per entry', async () => {
    mkdirSync(join(dir, 'threads'), { recursive: true });
    const ts = new Date().toISOString();
    writeFileSync(
      join(dir, 'threads', 'director.jsonl'),
      `${JSON.stringify({ ts, by: 'human', kind: 'line', body: 'Shop needs sale prices.' })}\n${JSON.stringify({ ts, by: 'director', kind: 'line', body: 'On it.' })}\n`,
    );
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      expect(await runDirectorTail({ home: dir, follow: false, json: false })).toBe(0);
    } finally {
      console.log = original;
    }
    expect(lines).toEqual([
      `${ts} human line: Shop needs sale prices.`,
      `${ts} director line: On it.`,
    ]);
  });
});
