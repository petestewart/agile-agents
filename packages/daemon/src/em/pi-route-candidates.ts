/**
 * Pi `(vendor, account, model)` route candidates for the engineer and
 * reviewer roles (T022 scope: "Routing table gains `(pi, account, model)`
 * candidates for engineer and reviewer").
 *
 * T022 round 2 (review N1: "nothing consumes pi-route-candidates ... so no
 * Pi session can be scheduled today"): `em/assign.ts`'s `defaultRoute` now
 * builds its ordered candidate list from these two arrays directly (Claude
 * first, still winning by default — see `assign.ts`'s `orderedCandidates`),
 * and `Runner.spawn` (`runner/runner.ts`) resolves `ticket.routing.vendor`
 * into an `AcpProviderConfig` at spawn time, so a `route` that actually
 * returns a Pi candidate (T023's real policy, or a caller-injected
 * `AssignReadyOptions.route` today) is now schedulable end to end. T023's
 * own `(role, tier) -> ordered candidates` policy (`src/quota/
 * routeCandidates`) isn't merged into this integration branch yet (PLAN.md
 * T023, "In Review" as of this ticket) — when it lands, it should read
 * these two arrays rather than re-deriving Pi's account ids from
 * `design/spike-findings.md` again.
 *
 * Account ids match `design/spike-findings.md` §C4 "Auth": "`/login`
 * supports Claude Pro/Max ..., ChatGPT Plus/Pro ..., xAI/Grok subscription,
 * OpenRouter OAuth, plus API keys in `~/.pi/agent/auth.json`" — Pi-on-Claude
 * is called out there as "a *different* quota record from Claude Code on
 * Max — pay-per-token extra usage, not the Max window", hence the
 * `pi-on-claude-max` account id (never `claude/max` — that id already names
 * the *Claude Code* adapter's own Max-window account in
 * `packages/shared/src/__fixtures__/vendors.yaml`, and conflating the two
 * would double-book one subscription's quota under two different quota
 * kinds). Models are Pi's model-catalog ids, not Claude Code's — Pi talks
 * to the same underlying model families through its own provider registry
 * (spike-findings.md §C4's `default provider opencode-go / glm-5.3` run
 * used pi's own catalog, not Claude Code's model ids).
 */

import type { RouteCandidate } from './assign';

/**
 * Engineer candidates: Pi is a strong tier-1 engineer per spike-findings.md
 * §C4 ("strongest tier-1 of any vendor: block-with-reason on every tool,
 * tool_result rewrite, cancel, resume") — billed off the Claude Max
 * subscription's extra-usage pool first, OpenRouter as a metered fallback
 * with no subscription window to exhaust.
 */
export const PI_ENGINEER_CANDIDATES: readonly RouteCandidate[] = Object.freeze([
  Object.freeze({ vendor: 'pi', account: 'pi-on-claude-max', model: 'claude-sonnet' }),
  Object.freeze({ vendor: 'pi', account: 'openrouter', model: 'claude-sonnet' }),
]);

/**
 * Reviewer candidates: same account ids as engineer (one Pi login, several
 * roles) — CLAUDE.md's demo epic pairs "Pi engineers and a Claude reviewer"
 * so this list exists for completeness/future sprints rather than the v0
 * demo path itself, which routes reviewer to Claude regardless.
 */
export const PI_REVIEWER_CANDIDATES: readonly RouteCandidate[] = Object.freeze([
  Object.freeze({ vendor: 'pi', account: 'pi-on-claude-max', model: 'claude-sonnet' }),
  Object.freeze({ vendor: 'pi', account: 'openrouter', model: 'claude-sonnet' }),
]);
