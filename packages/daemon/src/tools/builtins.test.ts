import { describe, expect, test } from 'bun:test';
import { normalizeBusSendInput } from './builtins';

// First live run (2026-09-10): engineers could not know their reviewer's
// agent id and guessed; `priority: "high"` was rejected nine times. These pin
// the affordances that make a `review_request` land on the first try.
describe('normalizeBusSendInput', () => {
  test('resolves role-name recipients to the caller ticket agent ids', () => {
    const out = normalizeBusSendInput(
      { to: ['reviewer', 'em', 'qa', 'engineer'], kind: 'review_request', body: 'x' },
      { ticket: 'TKT-1002' },
    );
    expect(out.to).toEqual(['reviewer-1002', 'em', 'qa-1002', 'eng-1002']);
  });

  test('leaves real agent ids and unknown strings untouched', () => {
    const out = normalizeBusSendInput(
      { to: ['reviewer-0007', 'human', 'ticket:TKT-0007'] },
      { ticket: 'TKT-0007' },
    );
    expect(out.to).toEqual(['reviewer-0007', 'human', 'ticket:TKT-0007']);
  });

  test('does not resolve aliases without a ticket context (nothing to resolve against)', () => {
    expect(normalizeBusSendInput({ to: ['reviewer'] }, {}).to).toEqual(['reviewer']);
  });

  test('priority defaults to normal and accepts common synonyms', () => {
    expect(normalizeBusSendInput({ to: ['em'] }, { ticket: 'TKT-1' }).priority).toBe('normal');
    expect(normalizeBusSendInput({ priority: 'high' }, {}).priority).toBe('urgent');
    expect(normalizeBusSendInput({ priority: 'Medium' }, {}).priority).toBe('normal');
    expect(normalizeBusSendInput({ priority: 'low' }, {}).priority).toBe('low');
    // An unknown spelling is passed through so the schema error names it.
    expect(normalizeBusSendInput({ priority: 'asap' }, {}).priority).toBe('asap');
  });
});
