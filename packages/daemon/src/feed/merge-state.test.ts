import { describe, expect, test } from 'bun:test';
import type { Stream } from '@agile-agents/shared';
import { type MergePreflight, NothingToMergeCache } from './merge-state';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function node(overrides: Partial<Stream> = {}): Stream {
  return {
    id: ID,
    title: 'empty',
    goal: 'g',
    repo: 'demo',
    branch: 'stream/empty',
    created_at: '2026-09-26T10:00:00.000Z',
    agent: { status: 'done', updated_at: '2026-09-26T10:05:00.000Z' },
    human: { status: 'open' },
    sessions: [],
    ...overrides,
  };
}

function harness(answer: () => MergePreflight) {
  const jobs: Array<() => void> = [];
  let now = 0;
  let calls = 0;
  let changes = 0;
  const cache = new NothingToMergeCache({
    preflight: () => {
      calls++;
      return answer();
    },
    ttlMs: 1000,
    now: () => now,
    schedule: (fn) => jobs.push(fn),
    onChange: () => changes++,
  });
  const run = (): void => {
    for (const job of jobs.splice(0)) job();
  };
  return {
    cache,
    run,
    advance: (ms: number) => {
      now += ms;
    },
    get calls() {
      return calls;
    },
    get changes() {
      return changes;
    },
  };
}

describe('NothingToMergeCache (T380)', () => {
  test('never runs git on the frame: the first peek schedules, a later one answers', () => {
    const h = harness(() => ({ ahead: 0 }));
    expect(h.cache.peek(node())).toBe(false);
    expect(h.calls).toBe(0);
    h.run();
    expect(h.calls).toBe(1);
    expect(h.changes).toBe(1);
    expect(h.cache.peek(node())).toBe(true);
    // Fresh: no second check, and repeated peeks queue nothing.
    h.run();
    expect(h.calls).toBe(1);
  });

  test('commits ahead, a merge done by hand, a conflict or a failed check keep Merge', () => {
    for (const answer of [
      { ahead: 2 },
      { ahead: 0, merged: true },
      { conflicts: ['a.ts'] },
      {},
    ] satisfies MergePreflight[]) {
      const h = harness(() => answer);
      h.cache.peek(node());
      h.run();
      expect(h.cache.peek(node())).toBe(false);
      expect(h.changes).toBe(0);
    }
    const throws = harness(() => {
      throw new Error('git failed');
    });
    throws.cache.peek(node());
    throws.run();
    expect(throws.cache.peek(node())).toBe(false);
  });

  test('only a finished, open work node on a branch is checked', () => {
    const h = harness(() => ({ ahead: 0 }));
    for (const s of [
      node({ agent: { status: 'working', updated_at: 't' } }),
      node({ human: { status: 'closed' } }),
      node({ branch: undefined }),
      node({ repo: undefined }),
      node({ archived: true }),
    ]) {
      expect(h.cache.peek(s)).toBe(false);
    }
    h.run();
    expect(h.calls).toBe(0);
  });

  test('a new finish, or the TTL, re-checks; the old answer holds meanwhile only for the same finish', () => {
    let ahead = 0;
    const h = harness(() => ({ ahead }));
    h.cache.peek(node());
    h.run();
    expect(h.cache.peek(node())).toBe(true);

    // The agent ran again and committed: a new `updated_at` is a new question.
    ahead = 1;
    const again = node({ agent: { status: 'done', updated_at: '2026-09-26T11:00:00.000Z' } });
    expect(h.cache.peek(again)).toBe(false);
    h.run();
    expect(h.cache.peek(again)).toBe(false);
    expect(h.changes).toBe(2);

    // A commit made by hand is seen once the answer is stale.
    ahead = 0;
    h.advance(1000);
    expect(h.cache.peek(again)).toBe(false);
    h.run();
    expect(h.cache.peek(again)).toBe(true);
    expect(h.calls).toBe(3);
  });
});
