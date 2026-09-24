/** Runtime predicates over the shared `GateOwner` type (the persisted shapes live in shared). */

import { type GateOwner, HUMAN_TIMEOUT_PATTERN } from '@agile-agents/shared';

export function isHumanTimeoutOwner(owner: GateOwner): boolean {
  return HUMAN_TIMEOUT_PATTERN.test(owner);
}

/** The `<d>` half of a `human_timeout:<d>` owner. */
export function humanTimeoutDuration(owner: GateOwner): string {
  return owner.slice('human_timeout:'.length);
}
