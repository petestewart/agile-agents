/**
 * T049 defect 8 — the follow-up title the Tickets pane asks the daemon for.
 * The duplicates Pete saw (TKT-2004/2005, both called "Add Ledger.transfer")
 * came from the pane sending the parent's own title back as `patch.title`,
 * which `applyPlanTicketEdit` uses verbatim; this is the one rule that stops
 * it. Plain `bun test` — a pure string function, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import { followUpTitle } from './TicketsPane';

describe('followUpTitle', () => {
  test('an unchanged title is prefixed, so the follow-up is never a duplicate', () => {
    expect(followUpTitle('Add Ledger.transfer', 'Add Ledger.transfer')).toBe(
      'Follow-up: Add Ledger.transfer',
    );
  });

  test('surrounding whitespace is not a change either', () => {
    expect(followUpTitle('Add Ledger.transfer', '  Add Ledger.transfer  ')).toBe(
      'Follow-up: Add Ledger.transfer',
    );
  });

  test('a retitled edit is used as typed', () => {
    expect(followUpTitle('Add Ledger.transfer', 'Reverse a transfer as a pair')).toBe(
      'Reverse a transfer as a pair',
    );
  });

  test('an emptied title falls back to the prefixed parent rather than to nothing', () => {
    expect(followUpTitle('Add Ledger.transfer', '   ')).toBe('Follow-up: Add Ledger.transfer');
  });
});
