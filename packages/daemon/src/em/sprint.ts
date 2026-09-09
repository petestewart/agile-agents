/**
 * Sprint planning — the dependency frontier (T015; design/
 * agile-agents-design.md §9 "Sprints as dependency layers": "the EM takes
 * the frontier — every `ready` ticket whose `depends` are all done — as the
 * next sprint, optionally capped in size").
 *
 * `computeFrontier` is a pure function over an in-memory ticket list so it's
 * cheap to unit-test against a fixture epic; `planSprint` is the thin
 * store-touching wrapper that mints the next `S-<n>` id, writes the sprint
 * file (with a recommended `gates` block copied from repo policy — §16:
 * "The EM's sprint proposal includes a recommended gate block ... the human
 * accepts or edits it as part of `approve_plan`"), and stamps `sprint` onto
 * each frontier ticket so a second `planSprint` call never re-includes it
 * ("not yet in a live sprint").
 */

import type { GatesBlock, Sprint, SprintId, Ticket, TicketId } from '@agile-agents/shared';
import { validateSprint } from '@agile-agents/shared';
import type { StateStore } from '../store';

/**
 * CLAUDE.md names no default sprint token budget (only per-ticket ceilings
 * and the quota floor); §4 "Sprint"'s own example (`budget_tokens:
 * 5000000`) is the only number the design ever gives, so it is reused
 * verbatim as the v0 default — DESIGN-GAP, overridable via
 * `PlanSprintOptions.budgetTokens`.
 */
export const DEFAULT_SPRINT_BUDGET_TOKENS = 5_000_000;

export interface ComputeFrontierOptions {
  /** Sprint size cap (§9: "optionally capped in size"). `undefined` = uncapped. */
  cap?: number;
}

/**
 * Every `ready` ticket whose `depends` are all `done` and which isn't
 * already claimed by a sprint (`ticket.sprint` unset — "not yet in a live
 * sprint"), ordered deterministically by id and capped at `opts.cap`.
 *
 * DESIGN-GAP: "ready/draft? — decide per §9" (session brief) — §9 says only
 * "every `ready` ticket", never `draft` (a `draft` ticket hasn't been
 * refined/pointed by the architect yet, so it has no `contract`/`estimate`
 * to hand an engineer); read literally, `draft` tickets are excluded here.
 */
export function computeFrontier(
  tickets: readonly Ticket[],
  opts: ComputeFrontierOptions = {},
): TicketId[] {
  const doneIds = new Set(tickets.filter((t) => t.status === 'done').map((t) => t.id));
  const candidates = tickets
    .filter((t) => t.status === 'ready')
    .filter((t) => t.sprint === undefined)
    .filter((t) => t.depends.every((dep) => doneIds.has(dep)))
    .map((t) => t.id)
    .sort((a, b) => a.localeCompare(b));
  return opts.cap !== undefined ? candidates.slice(0, opts.cap) : candidates;
}

/** Next `S-<n>` id — monotonic over every sprint ever created (mirrors `halts/index.ts`'s `nextHaltId`, minus the released-file wrinkle: sprint files are never deleted). */
export function nextSprintId(store: StateStore): SprintId {
  const existing = store.listSprints().map((s) => Number(s.id.slice('S-'.length)));
  const next =
    existing.length > 0 ? Math.max(...existing.filter((n) => Number.isFinite(n))) + 1 : 1;
  return `S-${next}` as SprintId;
}

/**
 * The "recommended gates block" the sprint proposal carries (§16: "a
 * recommended gate block with a one-line reason per gate; the human accepts
 * or edits it"). `GatesBlock` has no room for a per-gate reason string (a
 * flat `string -> owner` record, §16's own schema) — DESIGN-GAP: the
 * "reason" lives only in this function's doc comment / the rendered
 * `sprint-review`/`em` brief prose, not on the persisted sprint file. The
 * recommendation itself is simply the repo-default policy, copied onto the
 * sprint so a human editing the sprint file sees (and can override) the
 * gates actually in force for it, per §16's "most specific wins" resolution.
 */
function recommendedGates(store: StateStore): GatesBlock | undefined {
  try {
    return { ...store.getPolicy().gates };
  } catch {
    // No policy.yaml yet (pre-`agile init`, or a test fixture that never
    // seeded one) — no recommendation to make; `resolveGate` already falls
    // back to `human` for any gate with nothing at any level.
    return undefined;
  }
}

export interface PlanSprintOptions {
  cap?: number;
  goal?: string;
  budgetTokens?: number;
  now?: () => Date;
}

/**
 * Computes the frontier, mints the next sprint id, writes `sprints/S-<n>.yaml`
 * with a recommended `gates` block, and stamps `sprint: S-<n>` onto every
 * frontier ticket (via `putTicket` — the wholesale-replace helper, not
 * `transitionTicket`, since `sprint` isn't a status edge) so the next
 * `planSprint` call excludes them. Returns the saved `Sprint`.
 */
export async function planSprint(store: StateStore, opts: PlanSprintOptions = {}): Promise<Sprint> {
  const now = opts.now ?? (() => new Date());
  const tickets = store.listTickets();
  const frontier = computeFrontier(tickets, { cap: opts.cap });
  const id = nextSprintId(store);

  const sprint = validateSprint({
    id,
    goal: opts.goal ?? `Sprint ${id}`,
    tickets: frontier,
    budget_tokens: opts.budgetTokens ?? DEFAULT_SPRINT_BUDGET_TOKENS,
    started: now().toISOString(),
    gates: recommendedGates(store),
  });
  const saved = await store.putSprint(sprint);

  for (const ticketId of frontier) {
    const ticket = store.getTicket(ticketId);
    if (ticket.sprint === saved.id) continue;
    await store.putTicket({ ...ticket, sprint: saved.id }, { by: 'em' });
  }

  return saved;
}
