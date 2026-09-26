/** T411: a session's context window, from its vendor's `usage_update`. */

import { describe, expect, test } from 'bun:test';
import { contextUsageOf } from './session';

describe('contextUsageOf', () => {
  test('tokens used of the window, when both are sensible numbers', () => {
    expect(contextUsageOf({ sessionUpdate: 'usage_update', used: 46406, size: 200000 })).toEqual({
      used: 46406,
      size: 200000,
    });
    expect(contextUsageOf({ used: 10.6, size: 1000 })).toEqual({ used: 11, size: 1000 });
  });

  test('anything else is no reading', () => {
    expect(contextUsageOf(null)).toBeUndefined();
    expect(contextUsageOf({ used: 10 })).toBeUndefined();
    expect(contextUsageOf({ used: '10', size: 100 })).toBeUndefined();
    expect(contextUsageOf({ used: 10, size: 0 })).toBeUndefined();
    expect(contextUsageOf({ used: -1, size: 100 })).toBeUndefined();
    expect(contextUsageOf({ used: Number.NaN, size: 100 })).toBeUndefined();
  });
});
