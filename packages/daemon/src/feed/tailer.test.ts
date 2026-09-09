import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EventTailerHandle, startEventTailer } from './tailer';

let dir: string;
let path: string;
let handle: EventTailerHandle | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agile-feed-tailer-'));
  path = join(dir, 'events.jsonl');
});

afterEach(() => {
  handle?.stop();
  handle = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('startEventTailer', () => {
  test('emits a callback for each new complete line appended after start', () => {
    writeFileSync(path, '{"kind":"pre_existing"}\n');
    const received: unknown[] = [];
    handle = startEventTailer({ path, onEvents: (events) => received.push(...events) });

    // Starting offset is the file's current size: the pre-existing line must
    // never be re-emitted.
    handle.pollNow();
    expect(received).toEqual([]);

    appendFileSync(path, '{"kind":"a"}\n{"kind":"b"}\n');
    handle.pollNow();
    expect(received).toEqual([{ kind: 'a' }, { kind: 'b' }]);
  });

  test('holds a partial trailing line until it is completed by a later append', () => {
    writeFileSync(path, '');
    const received: unknown[] = [];
    handle = startEventTailer({ path, onEvents: (events) => received.push(...events) });

    appendFileSync(path, '{"kind":"a"}\n{"kind":"parti');
    handle.pollNow();
    expect(received).toEqual([{ kind: 'a' }]);

    appendFileSync(path, 'al"}\n');
    handle.pollNow();
    expect(received).toEqual([{ kind: 'a' }, { kind: 'partial' }]);
  });

  test('a malformed line is reported via onError and does not stop later lines from being parsed', () => {
    writeFileSync(path, '');
    const received: unknown[] = [];
    const errors: Error[] = [];
    handle = startEventTailer({
      path,
      onEvents: (events) => received.push(...events),
      onError: (err) => errors.push(err),
    });

    appendFileSync(path, 'not json\n{"kind":"ok"}\n');
    handle.pollNow();

    expect(errors.length).toBe(1);
    expect(received).toEqual([{ kind: 'ok' }]);
  });

  test('resumes from a given startOffset instead of the file end (restart-after-crash case)', () => {
    writeFileSync(path, '{"kind":"a"}\n');
    const firstReceived: unknown[] = [];
    const first = startEventTailer({
      path,
      startOffset: 0,
      onEvents: (events) => firstReceived.push(...events),
    });
    first.pollNow();
    expect(firstReceived).toEqual([{ kind: 'a' }]);
    const offsetAfterFirst = first.getOffset();
    first.stop();

    appendFileSync(path, '{"kind":"b"}\n');
    const secondReceived: unknown[] = [];
    handle = startEventTailer({
      path,
      startOffset: offsetAfterFirst,
      onEvents: (events) => secondReceived.push(...events),
    });
    handle.pollNow();
    // Only the line appended after the recorded offset — not "a" again.
    expect(secondReceived).toEqual([{ kind: 'b' }]);
  });

  test('does nothing (no throw) when the file does not exist yet', () => {
    handle = startEventTailer({ path: join(dir, 'does-not-exist.jsonl'), onEvents: () => {} });
    expect(() => handle?.pollNow()).not.toThrow();
  });

  test('getOffset advances by exactly the bytes consumed', () => {
    writeFileSync(path, '');
    handle = startEventTailer({ path, onEvents: () => {} });
    expect(handle.getOffset()).toBe(0);
    const line = '{"kind":"a"}\n';
    appendFileSync(path, line);
    handle.pollNow();
    expect(handle.getOffset()).toBe(Buffer.byteLength(line));
  });
});
