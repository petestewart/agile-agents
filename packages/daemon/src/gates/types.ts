/**
 * Local (non-persisted) helpers for the gates module (design
 * agile-agents-design.md §16 "HIL gates policy").
 *
 * T018 review fix: `HilRequest`/`BreakerState` and their validators used to
 * live here as hand-rolled types; they are now `packages/shared/src/hil.ts`
 * (`HilRequestSchema`/`BreakerStateSchema`, zod, strict — CLAUDE.md:
 * "Schemas live in `packages/shared` and nowhere else"), imported by
 * `service.ts`. This file keeps only small predicates over the shared
 * `GateOwner` type that have no reason to live in shared (they inspect a
 * runtime value, not describe a persisted shape).
 */

import { type GateOwner, HUMAN_TIMEOUT_PATTERN } from '@agile-agents/shared';

export function isHumanTimeoutOwner(owner: GateOwner): boolean {
  return HUMAN_TIMEOUT_PATTERN.test(owner);
}

/** The `<d>` half of a `human_timeout:<d>` owner. */
export function humanTimeoutDuration(owner: GateOwner): string {
  return owner.slice('human_timeout:'.length);
}
