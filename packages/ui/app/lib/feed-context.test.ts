/** T520 (audit U8): a `refresh()` read never puts back a state older than what the cockpit shows. */

import { describe, expect, test } from 'bun:test';
import { type RefreshMark, refreshLands } from './feed-context';

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
