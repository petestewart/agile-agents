/**
 * Cockpit §5.4's built-in pattern checks, created on daemon start as
 * global `standard` items with `action` enforcement (T260). Data rather
 * than code, so the posture is data: accepting `no-push` or retiring
 * `no-push-to-protected` takes effect on the next tool call (D7).
 *
 *  - Idempotent: identity is the pattern kind + `source.by: 'builtin'`
 *    (a minted ulid can't be fixed); a migrated built-in keeps both.
 *    The name is display only, so renaming one needs no migration.
 *  - A retired built-in stays retired: the existence check ignores
 *    `status`, so it is never re-created or re-accepted.
 *  - Written as `daemon`, straight through the store:
 *    `KnowledgeService.create` mints `proposed`, and these ship decided.
 *  - T371: an existing home's built-ins still carrying the words they
 *    shipped with (named after the pattern kind, a design-doc reference
 *    for a reason) are reworded in place on the next start; a name or
 *    text a human changed is left alone.
 */

import {
  type KnowledgeItem,
  type KnowledgeItemInput,
  type RulePattern,
  patternOf,
  ulid,
} from '@agile-agents/shared';
import type { StateStore } from '../store/store';

/** A §5.4 built-in, minus the fields the store/clock supply. */
interface BuiltinSpec {
  /** What the operator knows it by (display only: identity is the pattern kind). */
  name: string;
  pattern: RulePattern;
  text: string;
  /** `accepted` for the two on by default; `retired` for `no-push` (D7). */
  status: 'accepted' | 'retired';
  critical: boolean;
  /** Why the rule exists, in plain words: the item's "Why" (§5.1). */
  finding: string;
  /** The words an older home stored (T371), replaced on start while unchanged. */
  was: { name: string; text?: string; finding: string };
}

/** `source.by` of every built-in: half of the idempotence key. */
export const BUILTIN_PROVENANCE = 'builtin';

export const BUILTIN_KNOWLEDGE: readonly BuiltinSpec[] = [
  {
    name: 'no-push-to-protected',
    pattern: { kind: 'no_push_protected', args: {} },
    text: 'Never push to, or merge into, a protected branch. Each repo names its protected branches; they default to main and master.',
    status: 'accepted',
    critical: true,
    finding: 'This is the one action an agent can take that a human cannot cheaply undo.',
    was: {
      name: 'no_push_protected',
      text: 'Never push to, or merge into, a protected branch. Protected branches come from the repo entry in repos.yaml and default to main and master.',
      finding:
        'cockpit design §5.4, D8: this is the one action an agent can take that a human cannot cheaply undo',
    },
  },
  {
    name: 'no-push',
    pattern: { kind: 'no_push', args: {} },
    text: 'Never git push. Retired by default: a worker that cannot push cannot hand anything to CI or to a human on another machine. Accept this rule for the stricter posture.',
    status: 'retired',
    critical: false,
    finding:
      'Agents may push by default; the real risk is pushing to a protected branch, which no-push-to-protected already covers.',
    was: {
      name: 'no_push',
      finding:
        'cockpit design §5.4, D7: agents may git push by default; the real risk is pushing to something protected, which no_push_protected already covers',
    },
  },
  {
    name: 'stay-in-worktree',
    pattern: { kind: 'path_deny', args: { globs: [] } },
    text: "Never write outside the session's own worktree.",
    status: 'accepted',
    critical: true,
    finding:
      "Each node's agent works in its own worktree, so a write anywhere else could change another node's work or your own checkout.",
    was: { name: 'path_deny', finding: 'cockpit design §5.4 no_worktree_escape' },
  },
];

/** The `source.by` + pattern kind identity check. */
function isBuiltin(item: KnowledgeItem, kind: RulePattern['kind']): boolean {
  return item.source.by === BUILTIN_PROVENANCE && patternOf(item)?.kind === kind;
}

/** Creates any missing built-in and returns all of them in §5.4's order. Safe on every start. */
export async function ensureBuiltinKnowledge(
  store: StateStore,
  clock: () => Date = () => new Date(),
): Promise<KnowledgeItem[]> {
  const existing = store.listKnowledge();
  const result: KnowledgeItem[] = [];
  for (const spec of BUILTIN_KNOWLEDGE) {
    const found = existing.find((rule) => isBuiltin(rule, spec.pattern.kind));
    if (found !== undefined) {
      result.push(await upgrade(store, found, spec));
      continue;
    }
    const now = clock().toISOString();
    const record: KnowledgeItemInput = {
      id: `K-${ulid()}`,
      // The name the operator knows the check by.
      name: spec.name,
      kind: 'standard',
      text: spec.text,
      scope: { kind: 'global' },
      status: spec.status,
      enforcement: 'action',
      check: { by: 'pattern', pattern: spec.pattern },
      critical: spec.critical,
      source: { by: BUILTIN_PROVENANCE, finding: spec.finding },
      stats: {},
      created_at: now,
      decided_at: now,
      decided_by: BUILTIN_PROVENANCE,
    };
    result.push(await store.createKnowledge('daemon', record));
  }
  return result;
}

/**
 * Backfills a missing `name`, and (T371) rewords a built-in whose name,
 * text or reason is still exactly what an older daemon wrote. Anything a
 * human changed stays; status, check and stats are never touched.
 */
async function upgrade(
  store: StateStore,
  found: KnowledgeItem,
  spec: BuiltinSpec,
): Promise<KnowledgeItem> {
  const name = found.name === undefined || found.name === spec.was.name ? spec.name : found.name;
  const text = spec.was.text !== undefined && found.text === spec.was.text ? spec.text : found.text;
  const finding = found.source.finding === spec.was.finding ? spec.finding : found.source.finding;
  if (name === found.name && text === found.text && finding === found.source.finding) return found;
  return await store.updateKnowledge('daemon', found.id, (before) => ({
    ...before,
    name,
    text,
    source: { ...before.source, ...(finding !== undefined ? { finding } : {}) },
  }));
}
