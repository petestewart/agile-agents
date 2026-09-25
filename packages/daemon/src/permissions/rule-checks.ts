/**
 * One checker per `pattern.kind` (§5.2, §5.4): the deterministic half of
 * the rule pass. The hook consults the rules in scope, not a hardcoded
 * table, so a retired rule stops firing on the next call (§5.3; why
 * `no_push` can ship retired, D7). Every checker returns the deny reason
 * or `undefined`, and fails closed on a command it can't read (§8.1).
 */

import { DEFAULT_PROTECTED_BRANCHES, type Rule, type RulePattern } from '@agile-agents/shared';
import type { RuleStatsOutcome } from '../rules/service';
import {
  isPathInside,
  parseCommandIntoAtoms,
  parseGitInvocation,
  resolveTargetPath,
} from './command';
import { type PushDetectorContext, detectProtectedBranchWrite, detectPush } from './push-detector';

export interface RuleCheckContext extends PushDetectorContext {
  /** The session's worktree: the `no_worktree_escape` boundary (§5.4). */
  worktreePath: string;
  /** The `Bash` command this tool call runs, when it is one. */
  command?: string;
  /** Every path the tool call names. */
  paths?: readonly string[];
  /** The tool call writes: a read outside the worktree isn't what §5.4 prohibits. */
  writes?: boolean;
}

function pathMatchesGlob(path: string, glob: string): boolean {
  return new Bun.Glob(glob).match(path);
}

/** Subcommands that only read a repo (the reviewer's read-only git set). */
const READ_ONLY_GIT_SUBCOMMANDS = new Set(['diff', 'log', 'show', 'status']);

/** A read-only git call: no `-c` override (`-c alias.log=…`) and no `--output` file. */
function isReadOnlyGit(args: string[] | undefined, configs: readonly string[]): boolean {
  if (args === undefined || configs.length > 0) return false;
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(args[0] ?? '')) return false;
  return !args.some((a) => a === '--output' || a.startsWith('--output=') || a === '-o');
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
  // `git -C <elsewhere>` escapes the worktree without naming a path in
  // `tool_input`. A read-only one (T336: a coordinator's `git -C <part> log`)
  // writes nothing; what it may read is the role policy's and P13's call.
  if (ctx.command !== undefined) {
    for (const atom of parseCommandIntoAtoms(ctx.command)) {
      const git = parseGitInvocation(atom.tokens);
      if (isReadOnlyGit(git.args, git.configs)) continue;
      for (const cPath of git.cPaths) {
        // `~/x` is the home's, not the worktree's `./~/x`; `$X` can't be placed.
        const resolved = resolveTargetPath(cPath);
        if (!resolved.safe) return `git -C ${cPath} names a path that cannot be resolved`;
        if (!isPathInside(resolved.path, ctx.worktreePath)) {
          return `git -C ${cPath} targets a repo outside the session's worktree`;
        }
      }
    }
  }
  return undefined;
}

/** `command_deny`: patterns matched on the parsed atoms, never a raw substring. */
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
          // Backticks, not `"`: the reason reaches the model JSON-escaped.
          return `the command runs \`${pattern}\``;
        }
      }
    }
  }
  return undefined;
}

/** One pattern rule's verdict on one call: a deny reason, or `undefined`. Non-pattern rules return `undefined`. */
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

// The rule pass: one implementation for both tiers (the hook, §8.1, and the
// ACP responder, the only gate for a hook-less vendor, §4.3), so wording,
// order and stats can't drift.

/** Rules carrying a deterministic check: the only kind this pass evaluates. */
export function patternRulesOf(rules: readonly Rule[] | undefined): Rule[] {
  return (rules ?? []).filter(
    (rule) => rule.enforcement === 'pattern' && rule.pattern !== undefined,
  );
}

export interface PatternRuleOutcome {
  /** The deny reason naming the rule; `undefined` when every rule passed. */
  reason?: string;
  /** The rule the reason belongs to (`stats.violated`). */
  ruleViolated?: string;
  /** Every rule this pass evaluated, in order (`stats.fired`). */
  rulesEvaluated: string[];
}

/** Runs the rules in order and stops at the first deny (§8.1: match or uncertain ⇒ deny, rule named). */
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

// Daemon state the checkers need, resolved once for both tiers.

/** The slice of `StateStore` the protected-branch lookup needs. */
export interface RepoScopeStore {
  getStream(id: string): { repo?: string };
  getRepos(): Record<string, { protected_branches?: readonly string[] } | undefined>;
}

/**
 * The stream's repo `protected_branches` (D8), resolved at check time. No
 * repo, a vanished repo entry or a vanished stream fall back to
 * `[main, master]`, never to "nothing is protected".
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
  recordFired?(id: string, outcome: RuleStatsOutcome): Promise<unknown>;
}

/** One session's rule pass bound to its stream, for the ACP tier (`buildPermissionResponder`). */
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
        // A vanished stream must not crash a permission answer; the role table still gates.
        return [];
      }
    },
    protectedBranches: () => protectedBranchesFor(store, stream),
    record: async (id, outcome) => {
      try {
        await rules.recordFired?.(id, outcome);
      } catch {
        // Telemetry: losing a counter must not fail a decision.
      }
    },
  };
}
