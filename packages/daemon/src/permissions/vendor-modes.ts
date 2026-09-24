/**
 * Cursor's `ask` mode for reviewers (spike-findings.md §C3): the model
 * refuses writes citing its system prompt. A nudge, not a gate: Cursor
 * still raises a permission request for every exec, and the reviewer
 * table is what enforces.
 */

import type { PermissionRole } from './types';

/** Cursor's `session/set_mode` id for `role`, or `undefined` to keep its default (`agent`). */
export function cursorModeIdFor(role: PermissionRole): string | undefined {
  return role === 'reviewer' ? 'ask' : undefined;
}
