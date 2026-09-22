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

import type { Rule, RulePattern } from '@agile-agents/shared';
import { isPathInside, parseCommandIntoAtoms, parseGitInvocation } from './command';
import { type PushDetectorContext, detectPush, detectProtectedBranchWrite } from './push-detector';

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
    const needle = pattern.trim().split(/\s+/).filter((t) => t.length > 0);
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
