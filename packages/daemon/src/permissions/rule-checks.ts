/**
 * One checker per `pattern.kind` (design/cockpit-design.md §5.2's pattern
 * tier, §5.4's built-ins) — the deterministic half of the hook's rule pass.
 *
 * The point of this module is that the hook path consults **rules**, not a
 * hardcoded table: `hook/decide.ts` runs the pattern rules `rulesInScope`
 * returns for the session's stream and asks this function what each one
 * says about this tool call. A rule that is retired stops firing on the
 * next tool call with no restart and no code change (§5.3), which is the
 * whole reason `no_push` can ship retired (D7).
 *
 * Every checker returns the deny **reason** or `undefined`, and fails
 * closed: a command whose shape the detector cannot read denies (§8.1
 * "Detector uncertain ⇒ DENY").
 */

import { DEFAULT_PROTECTED_BRANCHES, type Rule, type RulePattern } from '@agile-agents/shared';
import { isPathInside, parseCommandIntoAtoms, parseGitInvocation } from './command';
import { type PushDetectorContext, detectProtectedBranchWrite, detectPush } from './push-detector';

export interface RuleCheckContext extends PushDetectorContext {
  /** The session's worktree — the boundary `path_deny` enforces (§5.4 `no_worktree_escape`). */
  worktreePath: string;
  /** The `Bash` command this tool call runs, when it is one. */
  command?: string;
  /** Every path the tool call names (`hook/decide.ts`'s `pathsForToolCall`). */
  paths?: readonly string[];
  /** True when the tool call writes (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`) — a read outside the worktree is not what §5.4 prohibits. */
  writes?: boolean;
}

function pathMatchesGlob(path: string, glob: string): boolean {
  return new Bun.Glob(glob).match(path);
}

/** `path_deny`: a write outside the worktree, or a path matching one of the rule's globs. */
function checkPathDeny(
  args: Extract<RulePattern, { kind: 'path_deny' }>['args'],
  ctx: RuleCheckContext,
): string | undefined {
  const paths = ctx.paths ?? [];
  if (ctx.writes === true) {
    const outside = paths.find((p) => !isPathInside(p, ctx.worktreePath));
    if (outside !== undefined) return `${outside} is outside the session's worktree`;
  }
  for (const path of paths) {
    const glob = args.globs.find((g) => pathMatchesGlob(path, g));
    if (glob !== undefined) return `${path} matches the denied path pattern ${glob}`;
  }
  // A command can escape the worktree without naming a path in
  // `tool_input`: `git -C <elsewhere>` retargets the whole invocation. This
  // is the check that replaced `policy-tables.ts`'s hardcoded
  // "git -C outside the worktree is never automatic" hil.
  if (ctx.command !== undefined) {
    for (const atom of parseCommandIntoAtoms(ctx.command)) {
      for (const cPath of parseGitInvocation(atom.tokens).cPaths) {
        if (!isPathInside(cPath, ctx.worktreePath)) {
          return `git -C ${cPath} targets a repo outside the session's worktree`;
        }
      }
    }
  }
  return undefined;
}

/** `command_deny`: the rule's patterns matched on the parsed atoms — never a substring of the raw line. */
function checkCommandDeny(
  args: Extract<RulePattern, { kind: 'command_deny' }>['args'],
  ctx: RuleCheckContext,
): string | undefined {
  if (ctx.command === undefined || args.patterns.length === 0) return undefined;
  const atoms = parseCommandIntoAtoms(ctx.command).map((atom) => atom.tokens);
  for (const pattern of args.patterns) {
    const needle = pattern
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (needle.length === 0) continue;
    for (const tokens of atoms) {
      for (let i = 0; i + needle.length <= tokens.length; i++) {
        if (needle.every((t, j) => tokens[i + j] === t)) {
          return `the command runs "${pattern}"`;
        }
      }
    }
  }
  return undefined;
}

/**
 * The verdict of one pattern rule on one tool call: a deny reason, or
 * `undefined` when the rule has nothing to say about this call. A rule
 * whose `enforcement` is not `pattern` (or that carries no `pattern`) is
 * not this module's business and returns `undefined` — the caller filters,
 * this is the belt.
 */
export function checkPatternRule(rule: Rule, ctx: RuleCheckContext): string | undefined {
  if (rule.enforcement !== 'pattern' || rule.pattern === undefined) return undefined;
  const pattern = rule.pattern;
  switch (pattern.kind) {
    case 'no_push_protected':
      return ctx.command === undefined ? undefined : detectProtectedBranchWrite(ctx.command, ctx);
    case 'no_push':
      return ctx.command === undefined ? undefined : detectPush(ctx.command);
    case 'path_deny':
      return checkPathDeny(pattern.args, ctx);
    case 'command_deny':
      return checkCommandDeny(pattern.args, ctx);
  }
}

// ---------------------------------------------------------------------------
// The rule pass itself — one implementation, two tiers. `hook/decide.ts`
// (Claude/Pi, design §8.1) and `permissions/decide.ts` (the ACP responder,
// which is the ONLY gate for a vendor with no pre-tool-use hook — Cursor,
// Codex, Grok; §4.3) both call `runPatternRules`, so the deny wording, the
// order and the stats accounting cannot drift between them.
// ---------------------------------------------------------------------------

/** A rule carrying a deterministic check — the only kind this pass evaluates. */
export function patternRulesOf(rules: readonly Rule[] | undefined): Rule[] {
  return (rules ?? []).filter(
    (rule) => rule.enforcement === 'pattern' && rule.pattern !== undefined,
  );
}

export interface PatternRuleOutcome {
  /** The deny reason, naming the rule — `undefined` when every rule passed. */
  reason?: string;
  /** The rule the reason belongs to (`stats.violated`). */
  ruleViolated?: string;
  /** Every rule this pass evaluated, in order (`stats.fired`). */
  rulesEvaluated: string[];
}

/**
 * Runs the pattern rules in scope, in order, and stops at the first deny —
 * "match ⇒ DENY with the rule named. Detector uncertain ⇒ DENY" (§8.1).
 */
export function runPatternRules(
  rules: readonly Rule[] | undefined,
  ctx: RuleCheckContext,
): PatternRuleOutcome {
  const rulesEvaluated: string[] = [];
  for (const rule of patternRulesOf(rules)) {
    rulesEvaluated.push(rule.id);
    const reason = checkPatternRule(rule, ctx);
    if (reason !== undefined) {
      return {
        reason: `rule ${rule.id} (${rule.pattern?.kind}): ${reason}`,
        ruleViolated: rule.id,
        rulesEvaluated,
      };
    }
  }
  return { rulesEvaluated };
}

// ---------------------------------------------------------------------------
// Resolving the two things the checkers need from daemon state, once, for
// both tiers.
// ---------------------------------------------------------------------------

/** The slice of `StateStore` the protected-branch lookup needs. */
export interface RepoScopeStore {
  getStream(id: string): { repo?: string };
  getRepos(): Record<string, { protected_branches?: readonly string[] } | undefined>;
}

/**
 * The stream's repo `protected_branches` (D8), resolved at check time
 * rather than frozen into the rule. A stream with no repo, a repo that has
 * gone from `repos.yaml`, or a stream that no longer exists falls back to
 * the same `[main, master]` default the schema applies — never to "nothing
 * is protected", which would make a missing entry an allow.
 */
export function protectedBranchesFor(
  store: RepoScopeStore,
  streamId: string | undefined,
): readonly string[] {
  if (streamId === undefined) return DEFAULT_PROTECTED_BRANCHES;
  try {
    const repo = store.getStream(streamId).repo;
    const entry = repo === undefined ? undefined : store.getRepos()[repo];
    return entry?.protected_branches ?? DEFAULT_PROTECTED_BRANCHES;
  } catch {
    return DEFAULT_PROTECTED_BRANCHES;
  }
}

/** The read/write sides of `RulesService` this pass uses (§5.3 and §5.7). */
export interface PatternRuleRules {
  inScope(streamId: string): Rule[];
  recordFired?(id: string, outcome: 'fired' | 'violated' | 'routed'): Promise<unknown>;
}

/**
 * Everything one session's rule pass needs, bound to its stream once:
 * handed to `buildPermissionResponder` by `runner/session.ts` so the ACP
 * tier gates the same rule set the hook tier does.
 */
export interface PatternRuleGate {
  rules(): Rule[];
  protectedBranches(): readonly string[];
  record(id: string, outcome: 'fired' | 'violated' | 'routed'): Promise<unknown>;
}

export function patternRuleGate(options: {
  store: RepoScopeStore;
  rules: PatternRuleRules;
  stream: string;
}): PatternRuleGate {
  const { store, rules, stream } = options;
  return {
    rules: () => {
      try {
        return patternRulesOf(rules.inScope(stream));
      } catch {
        // A stream that has gone is not a reason to crash a permission
        // answer — the role table still gates the call.
        return [];
      }
    },
    protectedBranches: () => protectedBranchesFor(store, stream),
    record: async (id, outcome) => {
      try {
        await rules.recordFired?.(id, outcome);
      } catch {
        // A counter is telemetry (§5.7's pruning input): losing one must
        // never turn a decision already made into an error.
      }
    },
  };
}
