/** Gate resolution (§3.1): one lookup, and a gate with no policy row resolves to `human`, never an auto-approve. */

import type { GateKind, GateOwner, Policy } from '@agile-agents/shared';

export interface GateResolutionContext {
  policy: Policy;
}

export function resolveGate(gate: GateKind, ctx: GateResolutionContext): GateOwner {
  return ctx.policy.gates[gate] ?? 'human';
}
