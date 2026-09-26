/**
 * T416: errors in words — a refused merge, a send that never reached the
 * daemon. Plain `bun test`, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import {
  SEND_UNREACHABLE,
  conflictMessage,
  isNetworkError,
  isNetworkMessage,
  mergeConflict,
  mergeRefusal,
  rebaseMessage,
  stripRefusal,
  writeFailure,
} from './errors';

describe('isNetworkError', () => {
  test("a fetch that never reached the daemon, in each browser's words", () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(
      isNetworkError(new TypeError('NetworkError when attempting to fetch resource.')),
    ).toBe(true);
    expect(isNetworkError(new TypeError('Load failed'))).toBe(true);
    expect(isNetworkError(new TypeError('fetch failed'))).toBe(true);
  });

  test("an HTTP refusal, or any other error, isn't one", () => {
    expect(isNetworkError(new Error('Failed to fetch'))).toBe(false);
    expect(isNetworkError(new Error('stream is closed'))).toBe(false);
    expect(isNetworkError(new TypeError('x is not a function'))).toBe(false);
    expect(isNetworkError('Failed to fetch')).toBe(false);
  });

  test('isNetworkMessage reads the text alone (what the Delivery hook keeps)', () => {
    expect(isNetworkMessage('Failed to fetch')).toBe(true);
    expect(isNetworkMessage('main moved; rebase the branch first')).toBe(false);
  });
});

describe('writeFailure', () => {
  test('a network failure says the daemon was not reached, and that nothing was sent', () => {
    expect(writeFailure(new TypeError('Failed to fetch'))).toBe(SEND_UNREACHABLE);
    expect(SEND_UNREACHABLE).toContain('wasn’t sent');
    expect(writeFailure(new TypeError('Failed to fetch'), 'Nothing was merged.')).toBe(
      'Nothing was merged.',
    );
  });

  test("the daemon's reason reads as a sentence", () => {
    expect(writeFailure(new Error('stream is closed'))).toBe('Stream is closed.');
    expect(writeFailure(new Error('Already a sentence.'))).toBe('Already a sentence.');
    expect(writeFailure('plain text')).toBe('Plain text.');
  });
});

describe('stripRefusal', () => {
  test('drops the daemon\'s lead-in, however many times it is there', () => {
    expect(stripRefusal('merge refused: main moved')).toBe('main moved');
    expect(stripRefusal('Merge refused: merge refused: main moved')).toBe('main moved');
    expect(stripRefusal('land refused — dirty checkout')).toBe('dirty checkout');
    expect(stripRefusal('refused: nope')).toBe('nope');
  });

  test('leaves a reason without one alone', () => {
    expect(stripRefusal('the branch has no commits beyond main')).toBe(
      'the branch has no commits beyond main',
    );
  });
});

describe('mergeRefusal', () => {
  test('the doubled prefix goes, the reason is capitalised, and "rebase" offers the fix', () => {
    const r = mergeRefusal('merge refused: main moved; rebase the branch first', 'main');
    expect(r.text).toBe('Main moved; rebase the branch first.');
    expect(r.fix?.kind).toBe('rebase');
    expect(r.fix?.label).toBe('Ask the agent to rebase');
    if (r.fix?.kind === 'rebase') {
      expect(r.fix.message).toContain('main');
      expect(r.fix.message).toContain('Main moved; rebase the branch first.');
    }
  });

  test('a live agent in the way offers Stop the agent', () => {
    const r = mergeRefusal(
      'Add CSV import still has a live agent; stop it or let it finish before merging',
    );
    expect(r.fix).toEqual({ kind: 'stop', label: 'Stop the agent' });
  });

  test('a reason with no fix the cockpit can do is words only', () => {
    const r = mergeRefusal(
      'main is checked out with uncommitted changes at /repo (a.ts); commit or stash them before merging',
    );
    expect(r.fix).toBeUndefined();
    expect(r.text.startsWith('Main is checked out')).toBe(true);
    expect(mergeRefusal('the branch add-csv has no commits beyond main — nothing to merge').fix)
      .toBeUndefined();
  });

  test("a node branch reads as its name, not its id (T413's rule)", () => {
    const r = mergeRefusal(
      'the branch stream/01ARZ3NDEKTSV4RRFFQ69G5FAV-add-csv-import is not merged into main',
    );
    expect(r.text).toBe('The branch add-csv-import is not merged into main.');
  });
});

describe('mergeConflict', () => {
  test('names the target and the count, and asks the agent to fix the files', () => {
    const one = mergeConflict('main', ['src/a.ts']);
    expect(one.text).toBe('Merging into main conflicts in 1 file.');
    expect(one.fix?.kind).toBe('conflicts');
    expect(mergeConflict('main', ['a', 'b']).text).toBe('Merging into main conflicts in 2 files.');
  });

  test('the prepared messages say what to do, and never merge by themselves', () => {
    expect(conflictMessage('main', ['src/a.ts', 'src/b.ts'])).toContain('`src/a.ts`, `src/b.ts`');
    expect(conflictMessage('main', [])).toContain('Merge main into your branch');
    expect(rebaseMessage('develop', 'Develop moved.')).toContain('up to date with develop');
  });
});
