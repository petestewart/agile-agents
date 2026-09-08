/**
 * Ported from Terma's acp-event-log.test.ts (vendor/terma/src/__tests__/unit/acp-event-log.test.ts),
 * `vitest` -> `bun:test`, `AcpEventLog` -> `EventLog`. Behaviour unchanged —
 * the ring's contract is the deliverable: sequence integrity, exact caps,
 * and truncation that is always accounted for.
 */
import { describe, expect, it } from 'bun:test';
import { EventLog, parseAcpEvent } from './events';

describe('EventLog', () => {
  type Ev = { acp: string; n?: number; blob?: string };

  it('assigns monotonic seq and replays events in order', () => {
    const log = new EventLog<Ev>();
    expect(log.append({ acp: 'notification', n: 1 }).seq).toBe(1);
    expect(log.append({ acp: 'notification', n: 2 }).seq).toBe(2);

    expect(log.replay()).toEqual({
      events: [
        { acp: 'notification', n: 1, seq: 1, gen: 1 },
        { acp: 'notification', n: 2, seq: 2, gen: 1 },
      ],
      dropped: 0,
      generation: 1,
    });
  });

  it('returns a snapshot, so a caller cannot mutate the ring', () => {
    const log = new EventLog<Ev>();
    log.append({ acp: 'notification', n: 1 });
    log.replay().events.push({ acp: 'injected', seq: 99, gen: 1 });
    expect(log.replay().events).toHaveLength(1);
  });

  describe('caps', () => {
    it('bounds at exactly the count it states', () => {
      const log = new EventLog<Ev>(10);
      for (let i = 1; i <= 10; i++) log.append({ acp: 'notification', n: i });
      expect(log.replay().dropped).toBe(0);

      log.append({ acp: 'notification', n: 11 });
      const replay = log.replay();
      expect(replay.events).toHaveLength(10);
      expect(replay.dropped).toBe(1);
    });

    it('head-truncates, keeping the newest events, and accounts for every drop', () => {
      const log = new EventLog<Ev>(10);
      for (let i = 1; i <= 40; i++) log.append({ acp: 'notification', n: i });

      const { events, dropped } = log.replay();
      expect(events).toHaveLength(10);
      expect(dropped).toBe(30);
      expect(dropped + events.length).toBe(40);
      expect(events[events.length - 1]).toMatchObject({ n: 40 });
      expect(events[0]).toMatchObject({ n: 31 });
    });

    it('truncates on the size budget even when the count cap is nowhere near', () => {
      const log = new EventLog<Ev>(1000, 2048);
      const blob = 'x'.repeat(500);
      for (let i = 0; i < 40; i++) log.append({ acp: 'notification', blob });

      const replay = log.replay();
      expect(replay.dropped).toBeGreaterThan(0);
      expect(replay.events.length).toBeLessThan(10);
      expect(replay.dropped + replay.events.length).toBe(40);
    });

    it('keeps the newest event even when a single frame exceeds the whole budget', () => {
      const log = new EventLog<Ev>(1000, 100);
      log.append({ acp: 'notification', blob: 'x'.repeat(5000) });
      log.append({ acp: 'notification', blob: 'y'.repeat(5000) });

      const replay = log.replay();
      expect(replay.events).toHaveLength(1);
      expect((replay.events[0] as Ev).blob?.startsWith('y')).toBe(true);
      expect(replay.dropped).toBe(1);
    });

    it('keeps seq gapless and monotonic across heavy truncation', () => {
      const log = new EventLog<Ev>(50);
      for (let i = 1; i <= 5000; i++) log.append({ acp: 'notification', n: i });

      const { events, dropped } = log.replay();
      const seqs = events.map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => 4951 + i));
      expect(dropped + events.length).toBe(5000);
    });
  });

  describe('reset', () => {
    it('clears the timeline but keeps seq monotonic', () => {
      const log = new EventLog<Ev>();
      log.append({ acp: 'notification', n: 1 });
      log.append({ acp: 'notification', n: 2 });

      log.reset();
      expect(log.replay()).toEqual({ events: [], dropped: 0, generation: 2 });

      expect(log.append({ acp: 'notification', n: 3 }).seq).toBe(3);
    });

    it('clears a prior truncation so it is not reported against the new timeline', () => {
      const log = new EventLog<Ev>(10);
      for (let i = 1; i <= 40; i++) log.append({ acp: 'notification', n: i });
      expect(log.replay().dropped).toBe(30);

      log.reset();
      expect(log.replay().dropped).toBe(0);
    });
  });

  describe('staged replacement', () => {
    const seed = (log: EventLog<Ev>, count: number) => {
      for (let i = 1; i <= count; i++) log.append({ acp: 'notification', n: i });
    };

    it('keeps serving the old timeline until the replacement commits', () => {
      const log = new EventLog<Ev>();
      seed(log, 3);

      log.beginReplace();
      expect(log.replay().events.map((e) => e.n)).toEqual([1, 2, 3]);

      log.append({ acp: 'notification', n: 9 });
      expect(log.replay().events.map((e) => e.n)).toEqual([1, 2, 3]);

      log.commitReplace();
      expect(log.replay().events.map((e) => e.n)).toEqual([9]);
    });

    it('restores the previous timeline when the replacement is aborted', () => {
      const log = new EventLog<Ev>();
      seed(log, 3);

      log.beginReplace();
      log.append({ acp: 'notification', n: 9 });
      log.abortReplace();

      expect(log.replay().events.map((e) => e.n)).toEqual([1, 2, 3]);
      expect(log.replay().dropped).toBe(0);
    });

    it('keeps seq monotonic across a replacement, so nothing collides', () => {
      const log = new EventLog<Ev>();
      seed(log, 3);

      log.beginReplace();
      const staged = log.append({ acp: 'notification', n: 9 });
      log.commitReplace();

      expect(staged.seq).toBe(4);
      expect(log.append({ acp: 'notification', n: 10 }).seq).toBe(5);
    });

    it('preserves the original timeline across nested replacements', () => {
      const log = new EventLog<Ev>();
      seed(log, 3);

      log.beginReplace();
      log.append({ acp: 'notification', n: 8 });
      log.beginReplace();
      log.append({ acp: 'notification', n: 9 });

      expect(log.replay().events.map((e) => e.n)).toEqual([1, 2, 3]);
      log.abortReplace();
      expect(log.replay().events.map((e) => e.n)).toEqual([1, 2, 3]);
    });

    it('changes generation when a replacement commits', () => {
      const log = new EventLog<Ev>();
      seed(log, 3);
      const before = log.replay().generation;

      log.beginReplace();
      log.append({ acp: 'notification', n: 9 });
      log.commitReplace();

      expect(log.replay().generation).not.toBe(before);
    });

    it('stamps staged events with the new generation before the commit', () => {
      const log = new EventLog<Ev>();
      seed(log, 3);
      const before = log.replay().generation;

      log.beginReplace();
      const staged = log.append({ acp: 'notification', n: 9 });

      expect(staged.gen).not.toBe(before);
      expect(log.replay().generation).toBe(before);
    });

    it('keeps the generation when a replacement is aborted', () => {
      const log = new EventLog<Ev>();
      seed(log, 3);
      const before = log.replay().generation;

      log.beginReplace();
      log.append({ acp: 'notification', n: 9 });
      log.abortReplace();

      expect(log.replay().generation).toBe(before);
    });

    it('gives every committed replacement a distinct generation', () => {
      const log = new EventLog<Ev>();
      const seen = new Set<number>([log.replay().generation]);
      for (let i = 0; i < 3; i++) {
        log.beginReplace();
        log.append({ acp: 'notification', n: i });
        log.commitReplace();
        seen.add(log.replay().generation);
      }
      expect(seen.size).toBe(4);
    });

    it('reports truncation of the staged timeline once committed', () => {
      const log = new EventLog<Ev>(5);
      seed(log, 3);

      log.beginReplace();
      for (let i = 1; i <= 20; i++) log.append({ acp: 'notification', n: i });
      expect(log.replay().dropped).toBe(0);

      log.commitReplace();
      const { events, dropped } = log.replay();
      expect(events).toHaveLength(5);
      expect(dropped).toBe(15);
      expect(dropped + events.length).toBe(20);
    });
  });
});

describe('parseAcpEvent', () => {
  it('decodes a well-formed notification, carrying seq/gen through', () => {
    const line = JSON.stringify({
      acp: 'notification',
      message: { jsonrpc: '2.0', method: 'session/update', params: { a: 1 } },
      seq: 3,
      gen: 1,
    });
    expect(parseAcpEvent(line)).toEqual({
      acp: 'notification',
      message: { jsonrpc: '2.0', method: 'session/update', params: { a: 1 } },
      seq: 3,
      gen: 1,
    });
  });

  it('returns null for unparseable JSON', () => {
    expect(parseAcpEvent('not json')).toBeNull();
  });

  it('returns null for a well-formed object with an unknown acp discriminant', () => {
    expect(parseAcpEvent(JSON.stringify({ acp: 'something-else' }))).toBeNull();
  });

  it('returns null for a request event missing method', () => {
    expect(parseAcpEvent(JSON.stringify({ acp: 'request', id: 1 }))).toBeNull();
  });

  it('decodes truncated events, including seq: 0', () => {
    expect(parseAcpEvent(JSON.stringify({ acp: 'truncated', dropped: 5, seq: 0, gen: 2 }))).toEqual(
      {
        acp: 'truncated',
        dropped: 5,
        seq: 0,
        gen: 2,
      },
    );
  });

  it('omits seq/gen when the envelope did not carry them', () => {
    expect(parseAcpEvent(JSON.stringify({ acp: 'initialized', result: {} }))).toEqual({
      acp: 'initialized',
      result: {},
    });
  });
});
