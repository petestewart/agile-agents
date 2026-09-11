/**
 * Gate resolution table (design/agile-agents-design.md §16 "HIL gates
 * policy"): "Resolution, most specific wins: sprint → epic → team →
 * repo default. The sprint file carries its own `gates:` block."
 *
 * `sprint` / `epic` / `team` are optional `GatesBlock`-shaped overrides —
 * e.g. a caller passes `sprint.gates` straight from a loaded `Sprint`
 * (shared already models that field; §4 "Sprint" / `GatesBlockSchema`).
 * Nothing epic- or team-scoped exists in `shared` yet (no `Epic`/`Team`
 * entity), so those two levels are accepted as plain overrides the caller
 * supplies from wherever they end up living — this function only does the
 * precedence walk.
 */

import type { GateOwner, GatesBlock, Policy } from '@agile-agents/shared';

export interface GateResolutionContext {
  policy: Policy;
  sprint?: GatesBlock;
  epic?: GatesBlock;
  team?: GatesBlock;
}

/**
 * Most-specific-wins lookup: sprint → epic → team → repo-default
 * (`policy.gates`). An unknown gate name — absent at every level — resolves
 * to `human` (T018 acceptance criterion), matching §16's fail-safe framing
 * (a gate nobody named a policy for should not silently auto-approve).
 */
export function resolveGate(gate: string, ctx: GateResolutionContext): GateOwner {
  return (
    ctx.sprint?.[gate] ?? ctx.epic?.[gate] ?? ctx.team?.[gate] ?? ctx.policy.gates[gate] ?? 'human'
  );
}
