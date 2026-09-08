import { describe, it, expect } from "vitest";
import { AcpEventLog } from "../../main/terminal-host/acp-event-log";

/**
 * The event ring is a bounded in-memory timeline for repainting an agent pane
 * on attach. Its contract is the deliverable: sequence integrity, exact caps,
 * and truncation that is always accounted for.
 */
describe("AcpEventLog", () => {
  type Ev = { acp: string; n?: number; blob?: string };

  it("assigns monotonic seq and replays events in order", () => {
    const log = new AcpEventLog<Ev>();
    expect(log.append({ acp: "notification", n: 1 }).seq).toBe(1);
    expect(log.append({ acp: "notification", n: 2 }).seq).toBe(2);

    expect(log.replay()).toEqual({
      events: [
        { acp: "notification", n: 1, seq: 1, gen: 1 },
        { acp: "notification", n: 2, seq: 2, gen: 1 },
      ],
      dropped: 0,
      generation: 1,
    });
  });

  it("returns a snapshot, so a caller cannot mutate the ring", () => {
    const log = new AcpEventLog<Ev>();
    log.append({ acp: "notification", n: 1 });
    log.replay().events.push({ acp: "injected", seq: 99, gen: 1 });
    expect(log.replay().events).toHaveLength(1);
  });

  describe("caps", () => {
    it("bounds at exactly the count it states", () => {
      // The earlier file-backed version amortised compaction and so actually
      // bounded at 1.5x the stated cap; the ring trims on every append.
      const log = new AcpEventLog<Ev>(10);
      for (let i = 1; i <= 10; i++) log.append({ acp: "notification", n: i });
      expect(log.replay().dropped).toBe(0);

      log.append({ acp: "notification", n: 11 });
      const replay = log.replay();
      expect(replay.events).toHaveLength(10);
      expect(replay.dropped).toBe(1);
    });

    it("head-truncates, keeping the newest events, and accounts for every drop", () => {
      const log = new AcpEventLog<Ev>(10);
      for (let i = 1; i <= 40; i++) log.append({ acp: "notification", n: i });

      const { events, dropped } = log.replay();
      expect(events).toHaveLength(10);
      expect(dropped).toBe(30);
      // Nothing vanishes unaccounted for.
      expect(dropped + events.length).toBe(40);
      // The tail survives, not the head.
      expect(events[events.length - 1]).toMatchObject({ n: 40 });
      expect(events[0]).toMatchObject({ n: 31 });
    });

    it("truncates on the size budget even when the count cap is nowhere near", () => {
      // 1000 entries allowed, but only ~2 KB of them.
      const log = new AcpEventLog<Ev>(1000, 2048);
      const blob = "x".repeat(500);
      for (let i = 0; i < 40; i++) log.append({ acp: "notification", blob });

      const replay = log.replay();
      expect(replay.dropped).toBeGreaterThan(0);
      expect(replay.events.length).toBeLessThan(10);
      expect(replay.dropped + replay.events.length).toBe(40);
    });

    it("keeps the newest event even when a single frame exceeds the whole budget", () => {
      const log = new AcpEventLog<Ev>(1000, 100);
      log.append({ acp: "notification", blob: "x".repeat(5000) });
      log.append({ acp: "notification", blob: "y".repeat(5000) });

      const replay = log.replay();
      expect(replay.events).toHaveLength(1);
      expect(replay.events[0].blob!.startsWith("y")).toBe(true);
      expect(replay.dropped).toBe(1);
    });

    it("keeps seq gapless and monotonic across heavy truncation", () => {
      const log = new AcpEventLog<Ev>(50);
      for (let i = 1; i <= 5000; i++) log.append({ acp: "notification", n: i });

      const { events, dropped } = log.replay();
      const seqs = events.map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => 4951 + i));
      expect(dropped + events.length).toBe(5000);
    });
  });

  describe("reset", () => {
    it("clears the timeline but keeps seq monotonic", () => {
      const log = new AcpEventLog<Ev>();
      log.append({ acp: "notification", n: 1 });
      log.append({ acp: "notification", n: 2 });

      log.reset();
      expect(log.replay()).toEqual({ events: [], dropped: 0, generation: 2 });

      // Continuing the sequence is what lets a client that already painted
      // seq 1-2 recognise post-reset frames as new.
      expect(log.append({ acp: "notification", n: 3 }).seq).toBe(3);
    });

    it("clears a prior truncation so it is not reported against the new timeline", () => {
      const log = new AcpEventLog<Ev>(10);
      for (let i = 1; i <= 40; i++) log.append({ acp: "notification", n: i });
      expect(log.replay().dropped).toBe(30);

      log.reset();
      expect(log.replay().dropped).toBe(0);
    });
  });

  describe("staged replacement", () => {
    const seed = (log: AcpEventLog<Ev>, count: number) => {
      for (let i = 1; i <= count; i++) log.append({ acp: "notification", n: i });
    };

    it("keeps serving the old timeline until the replacement commits", () => {
      const log = new AcpEventLog<Ev>();
      seed(log, 3);

      log.beginReplace();
      // A reader during the load window must not see an empty timeline.
      expect(log.replay().events.map((e) => e.n)).toEqual([1, 2, 3]);

      log.append({ acp: "notification", n: 9 });
      expect(log.replay().events.map((e) => e.n)).toEqual([1, 2, 3]);

      log.commitReplace();
      expect(log.replay().events.map((e) => e.n)).toEqual([9]);
    });

    it("restores the previous timeline when the replacement is aborted", () => {
      const log = new AcpEventLog<Ev>();
      seed(log, 3);

      log.beginReplace();
      log.append({ acp: "notification", n: 9 });
      log.abortReplace();

      // A failed load must not be able to empty the ring.
      expect(log.replay().events.map((e) => e.n)).toEqual([1, 2, 3]);
      expect(log.replay().dropped).toBe(0);
    });

    it("keeps seq monotonic across a replacement, so nothing collides", () => {
      const log = new AcpEventLog<Ev>();
      seed(log, 3);

      log.beginReplace();
      const staged = log.append({ acp: "notification", n: 9 });
      log.commitReplace();

      expect(staged.seq).toBe(4);
      expect(log.append({ acp: "notification", n: 10 }).seq).toBe(5);
    });

    it("preserves the original timeline across nested replacements", () => {
      const log = new AcpEventLog<Ev>();
      seed(log, 3);

      // Overlapping loads: the second begins before the first resolves.
      log.beginReplace();
      log.append({ acp: "notification", n: 8 });
      log.beginReplace();
      log.append({ acp: "notification", n: 9 });

      // Still the original, and an abort must restore that same original
      // rather than the first replacement's partial work.
      expect(log.replay().events.map((e) => e.n)).toEqual([1, 2, 3]);
      log.abortReplace();
      expect(log.replay().events.map((e) => e.n)).toEqual([1, 2, 3]);
    });

    /**
     * The generation exists because `seq` cannot express "this replaces what
     * you painted". After a load the new events carry *higher* seqs than
     * everything already on screen, so a client merging on seq alone keeps both
     * copies and the conversation doubles — the failure this project has fixed
     * repeatedly. These tests pin the property a consumer relies on.
     */
    it("changes generation when a replacement commits", () => {
      const log = new AcpEventLog<Ev>();
      seed(log, 3);
      const before = log.replay().generation;

      log.beginReplace();
      log.append({ acp: "notification", n: 9 });
      log.commitReplace();

      expect(log.replay().generation).not.toBe(before);
    });

    it("stamps staged events with the new generation before the commit", () => {
      const log = new AcpEventLog<Ev>();
      seed(log, 3);
      const before = log.replay().generation;

      log.beginReplace();
      const staged = log.append({ acp: "notification", n: 9 });

      // Live delivery happens at append time, so a client receiving this frame
      // must be able to tell it apart from the timeline it replaces *now*, not
      // once the load resolves.
      expect(staged.gen).not.toBe(before);
      expect(log.replay().generation).toBe(before);
    });

    it("keeps the generation when a replacement is aborted", () => {
      const log = new AcpEventLog<Ev>();
      seed(log, 3);
      const before = log.replay().generation;

      log.beginReplace();
      log.append({ acp: "notification", n: 9 });
      log.abortReplace();

      // A failed load replaced nothing, so a client's timeline is still valid.
      expect(log.replay().generation).toBe(before);
    });

    it("gives every committed replacement a distinct generation", () => {
      const log = new AcpEventLog<Ev>();
      const seen = new Set<number>([log.replay().generation]);
      for (let i = 0; i < 3; i++) {
        log.beginReplace();
        log.append({ acp: "notification", n: i });
        log.commitReplace();
        seen.add(log.replay().generation);
      }
      expect(seen.size).toBe(4);
    });

    it("reports truncation of the staged timeline once committed", () => {
      const log = new AcpEventLog<Ev>(5);
      seed(log, 3);

      log.beginReplace();
      for (let i = 1; i <= 20; i++) log.append({ acp: "notification", n: i });
      // Pre-commit the reader still sees the untruncated old timeline.
      expect(log.replay().dropped).toBe(0);

      log.commitReplace();
      const { events, dropped } = log.replay();
      expect(events).toHaveLength(5);
      expect(dropped).toBe(15);
      expect(dropped + events.length).toBe(20);
    });
  });
});
