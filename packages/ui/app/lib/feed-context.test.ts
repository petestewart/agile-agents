/** T520 (audit U8): a `refresh()` read never puts back a state older than what the cockpit shows. */

import { describe, expect, test } from 'bun:test';
import { type RefreshMark, createReloader, refreshLands } from './feed-context';

/** `FeedProvider`'s bookkeeping: a read is sent, a frame arrives, a read comes back. */
function feed(): {
  send(): RefreshMark;
  frame(): void;
  lands(sent: RefreshMark): boolean;
} {
  let now: RefreshMark = { refreshes: 0, frames: 0 };
  return {
    send: () => {
      now = { ...now, refreshes: now.refreshes + 1 };
      return now;
    },
    frame: () => {
      now = { ...now, frames: now.frames + 1 };
    },
    lands: (sent) => refreshLands(sent, now),
  };
}

describe('refreshLands', () => {
  test('a read with nothing after it lands', () => {
    const cockpit = feed();
    const read = cockpit.send();
    expect(cockpit.lands(read)).toBe(true);
  });

  test('a read older than a frame received since it was sent is ignored', () => {
    const cockpit = feed();
    const read = cockpit.send();
    cockpit.frame();
    expect(cockpit.lands(read)).toBe(false);
  });

  test('frames received before the read was sent do not hold it back', () => {
    const cockpit = feed();
    cockpit.frame();
    cockpit.frame();
    const read = cockpit.send();
    expect(cockpit.lands(read)).toBe(true);
  });

  test('two reads resolving out of order: only the latest lands', () => {
    const cockpit = feed();
    const first = cockpit.send();
    const second = cockpit.send();
    expect(cockpit.lands(second)).toBe(true);
    expect(cockpit.lands(first)).toBe(false);
  });

  test('two reads in order: the older one is dropped even when it comes back first', () => {
    const cockpit = feed();
    const first = cockpit.send();
    const second = cockpit.send();
    expect(cockpit.lands(first)).toBe(false);
    expect(cockpit.lands(second)).toBe(true);
  });

  test('a frame between two reads holds back the first, not the second', () => {
    const cockpit = feed();
    const first = cockpit.send();
    cockpit.frame();
    const second = cockpit.send();
    expect(cockpit.lands(first)).toBe(false);
    expect(cockpit.lands(second)).toBe(true);
  });
});

describe('createReloader (T548)', () => {
  /** A hand-driven clock: `tick(ms)` runs what is due. */
  function fakeClock() {
    let now = 0;
    let timers: Array<{ at: number; run: () => void; id: number }> = [];
    let nextId = 1;
    return {
      clock: {
        now: () => now,
        set: (run: () => void, ms: number) => {
          const id = nextId++;
          timers.push({ at: now + ms, run, id });
          return id;
        },
        clear: (id: unknown) => {
          timers = timers.filter((t) => t.id !== id);
        },
      },
      async tick(ms: number) {
        now += ms;
        const due = timers.filter((t) => t.at <= now);
        timers = timers.filter((t) => t.at > now);
        for (const t of due) t.run();
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  test('frames inside the gap make one trailing load; never two at once', async () => {
    const { clock, tick } = fakeClock();
    let loads = 0;
    let finish: () => void = () => {};
    const load = () => {
      loads += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    const r = createReloader(load, 400, clock);
    r.schedule();
    await settle();
    expect(loads).toBe(1);
    // Ten frames while the first load is in flight and inside the gap.
    for (let i = 0; i < 10; i++) r.schedule();
    await tick(100);
    expect(loads).toBe(1);
    finish();
    await settle();
    expect(loads).toBe(1);
    await tick(300);
    await settle();
    expect(loads).toBe(2);
    finish();
    await settle();
    // Nothing new: no third load.
    await tick(1000);
    expect(loads).toBe(2);
  });

  test('a frame after the gap loads at once; cancel stops a waiting load', async () => {
    const { clock, tick } = fakeClock();
    let loads = 0;
    const r = createReloader(
      async () => {
        loads += 1;
      },
      400,
      clock,
    );
    r.schedule();
    await settle();
    await tick(500);
    r.schedule();
    await settle();
    expect(loads).toBe(2);
    r.schedule();
    r.cancel();
    await tick(1000);
    await settle();
    expect(loads).toBe(2);
  });
});
