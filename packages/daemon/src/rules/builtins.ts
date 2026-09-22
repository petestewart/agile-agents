/**
 * The built-in pattern rules of design/cockpit-design.md §5.4, created as
 * global rules on daemon start (T143).
 *
 * They are rules rather than code so that the posture is data: a repo that
 * wants agents not to push at all accepts `no_push` (D7's "flips one field
 * instead of writing code"), and a human who decides `no_push_protected`
 * is wrong for their setup retires it — both take effect on the next tool
 * call, because the hook reads `rulesInScope` per call (§5.3).
 *
 * Three properties this module owes the rest of the system:
 *
 *  - **idempotent.** Identity is `pattern.kind` + `provenance.by:
 *    'builtin'`, not the ulid id, so a second daemon start finds them and
 *    creates nothing. (An id could not be fixed anyway: `R-<ulid>` is
 *    minted, and §5.1's record has no other stable key.)
 *  - **a retired built-in stays retired.** The existence check ignores
 *    `status`, so a `no_push` the human retired — or an accepted one they
 *    later retired — is never re-created and never re-accepted. This is
 *    the one property that would make the built-ins worse than a hardcoded
 *    table if it were missing.
 *  - **written as `daemon`.** §5.1's D4 split reserves `status` for the
 *    human, and the daemon; an agent principal could not create these at
 *    all (`assertRuleWrite`), which is the point.
 *
 * `RulesService.create` is deliberately not used: it mints every rule
 * `proposed` ("a proposal is not a rule"), and §5.4's built-ins ship
 * already decided — two of them accepted, one retired. So they go straight
 * through the store, which is still the one validating writer of `rules/`.
 */

import { type Rule, type RuleInput, type RulePattern, ulid } from '@agile-agents/shared';
import type { StateStore } from '../store/store';

/** A §5.4 built-in, minus the fields the store/clock supply. */
interface BuiltinRuleSpec {
  pattern: RulePattern;
  text: string;
  /** `accepted` for the two that are on by default; `retired` for `no_push` (D7). */
  status: 'accepted' | 'retired';
  critical: boolean;
  /** The design paragraph and decision this rule is, for "why does this rule exist" six months later (§5.1). */
  finding: string;
}

/** `provenance.by` for every rule this module creates — half of the idempotence key. */
export const BUILTIN_PROVENANCE = 'builtin';

export const BUILTIN_RULES: readonly BuiltinRuleSpec[] = [
  {
    pattern: { kind: 'no_push_protected', args: {} },
    text: 'Never push to, or merge into, a protected branch. Protected branches come from the repo entry in repos.yaml and default to main and master.',
    status: 'accepted',
    critical: true,
    finding:
      'cockpit design §5.4, D8: this is the one action an agent can take that a human cannot cheaply undo',
  },
  {
    pattern: { kind: 'no_push', args: {} },
    text: 'Never git push. Retired by default: a worker that cannot push cannot hand anything to CI or to a human on another machine. Accept this rule for the stricter posture.',
    status: 'retired',
    critical: false,
    finding:
      'cockpit design §5.4, D7: agents may git push by default; the real risk is pushing to something protected, which no_push_protected already covers',
  },
  {
    pattern: { kind: 'path_deny', args: { globs: [] } },
    text: "Never write outside the session's own worktree.",
    status: 'accepted',
    critical: true,
    finding: 'cockpit design §5.4 no_worktree_escape',
  },
];

/** The `provenance.by`/`pattern.kind` identity check — see this file's header. */
function isBuiltin(rule: Rule, kind: RulePattern['kind']): boolean {
  return rule.provenance.by === BUILTIN_PROVENANCE && rule.pattern?.kind === kind;
}

/**
 * Creates any §5.4 built-in this home does not already have, and returns
 * every built-in now on file (created or pre-existing), in §5.4's order.
 * Safe to call on every daemon start.
 */
export async function ensureBuiltinRules(
  store: StateStore,
  clock: () => Date = () => new Date(),
): Promise<Rule[]> {
  const existing = store.listRules();
  const result: Rule[] = [];
  for (const spec of BUILTIN_RULES) {
    const found = existing.find((rule) => isBuiltin(rule, spec.pattern.kind));
    if (found !== undefined) {
      result.push(found);
      continue;
    }
    const now = clock().toISOString();
    const record: RuleInput = {
      id: `R-${ulid()}`,
      text: spec.text,
      scope: { kind: 'global' },
      status: spec.status,
      enforcement: 'pattern',
      stage: 'action',
      pattern: spec.pattern,
      critical: spec.critical,
      examples: [],
      provenance: { by: BUILTIN_PROVENANCE, finding: spec.finding },
      stats: {},
      created_at: now,
      decided_at: now,
      decided_by: BUILTIN_PROVENANCE,
    };
    result.push(await store.createRule('daemon', record));
  }
  return result;
}
