/**
 * Gate resolution (design/cockpit-design.md §3.1).
 *
 * T121 collapsed this to one lookup. The old table walked sprint → epic →
 * team → repo default, because a sprint file carried its own `gates:`
 * block; sprints, epics and teams are gone with the ceremony layer, and
 * `gates` is a closed three-row map (`GatesBlockSchema`). What survives is
 * the fail-safe: a gate with no policy row resolves to `human`, never to a
 * silent auto-approve.
 */

import type { GateKind, GateOwner, Policy } from '@agile-agents/shared';

export interface GateResolutionContext {
  policy: Policy;
}

export function resolveGate(gate: GateKind, ctx: GateResolutionContext): GateOwner {
  return ctx.policy.gates[gate] ?? 'human';
}
