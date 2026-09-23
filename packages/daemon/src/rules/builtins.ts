/**
 * §5.4's built-in pattern rules, created as global rules on daemon start.
 * Rules rather than code, so the posture is data: accepting `no_push` or
 * retiring `no_push_protected` takes effect on the next tool call (D7).
 *
 *  - Idempotent: identity is `pattern.kind` + `provenance.by: 'builtin'`
 *    (a minted ulid can't be fixed).
 *  - A retired built-in stays retired: the existence check ignores
 *    `status`, so it is never re-created or re-accepted.
 *  - Written as `daemon`, straight through the store:
 *    `RulesService.create` mints `proposed`, and these ship decided.
 */

import { type Rule, type RuleInput, type RulePattern, ulid } from '@agile-agents/shared';
import type { StateStore } from '../store/store';

/** A §5.4 built-in, minus the fields the store/clock supply. */
interface BuiltinRuleSpec {
  pattern: RulePattern;
  text: string;
  /** `accepted` for the two on by default; `retired` for `no_push` (D7). */
  status: 'accepted' | 'retired';
  critical: boolean;
  /** The design paragraph behind the rule, for "why does it exist" later (§5.1). */
  finding: string;
}

/** `provenance.by` of every built-in: half of the idempotence key. */
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

/** The `provenance.by` + `pattern.kind` identity check. */
function isBuiltin(rule: Rule, kind: RulePattern['kind']): boolean {
  return rule.provenance.by === BUILTIN_PROVENANCE && rule.pattern?.kind === kind;
}

/** Creates any missing built-in and returns all of them in §5.4's order. Safe on every start. */
export async function ensureBuiltinRules(
  store: StateStore,
  clock: () => Date = () => new Date(),
): Promise<Rule[]> {
  const existing = store.listRules();
  const result: Rule[] = [];
  for (const spec of BUILTIN_RULES) {
    const found = existing.find((rule) => isBuiltin(rule, spec.pattern.kind));
    if (found !== undefined) {
      // Backfill `name` on a built-in that predates it; nothing else is touched.
      result.push(
        found.name === spec.pattern.kind
          ? found
          : await store.updateRule('daemon', found.id, (before) => ({
              ...before,
              name: spec.pattern.kind,
            })),
      );
      continue;
    }
    const now = clock().toISOString();
    const record: RuleInput = {
      id: `R-${ulid()}`,
      // The §5.4 name the operator knows the rule by.
      name: spec.pattern.kind,
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
