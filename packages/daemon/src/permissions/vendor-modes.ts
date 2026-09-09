/**
 * Cursor's `ask` mode for reviewers (T027 — design/spike-findings.md §C3):
 * "Cursor `ask` mode: writes refused by the *model* citing its system
 * prompt ('Ask mode is active… MUST NOT make any edits'); exec still raises
 * ACP permission requests. Prompt-level restriction, not enforcement —
 * useful for reviewers as a nudge, not a gate."
 *
 * So this is additive to tier 2, never a substitute for it: Cursor still
 * raises an ACP permission request for every exec regardless of mode
 * (§C2 — "in `agent` mode raises a permission request for every exec …
 * none for edits or reads"), and `decidePermission`/`policy-tables.ts`'s
 * reviewer table (which denies `edit`/`execute` unconditionally,
 * vendor-agnostically) is what actually gates a Cursor reviewer. `ask`
 * mode only saves a denied round trip when the model behaves — it is not
 * this ticket's enforcement mechanism and must never be treated as one.
 *
 * Wiring point: `runner/session.ts` uses this to pick `SpawnSessionOptions.
 * modeId` instead of the flat `'default'` every other vendor/role keeps.
 */

import type { PermissionRole } from './types';

/**
 * ACP `session/set_mode` id for `role` on Cursor, or `undefined` to leave
 * Cursor's own default mode (`agent`) alone. Cursor-specific: no other
 * registered vendor has an equivalent role-based "nudge" mode measured
 * (Claude's `plan` mode is a different gate entirely — §16's
 * `approve_plan`, driven by the architect/EM planning turn, not a
 * per-role reviewer default).
 */
export function cursorModeIdFor(role: PermissionRole): string | undefined {
  return role === 'reviewer' ? 'ask' : undefined;
}
