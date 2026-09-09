/**
 * QA's contract-input/output read denial (T017 — design/agile-agents-design.md
 * §13: "QA's tool permissions deny Read/grep on `contract.outputs` and
 * `contract.inputs`" — and §14's own table entry for QA, which
 * `permissions/policy-tables.ts`'s `qaVerdict` already flags as a
 * DESIGN-GAP: "the contract-scoped exclusion is enforced by whatever hands
 * QA its tool permissions ... not by this generic ACP layer, which has no
 * contract in scope").
 *
 * This ticket owns `packages/daemon/src/qa/**` only — NOT `hook/decide.ts`
 * or `permissions/**` — so the enforcement seam this module plugs into is
 * named, not wired, here. See this file's bottom doc comment ("Wiring for
 * the manager") for the exact one-line change `hook/decide.ts` needs.
 */

import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Ticket } from '@agile-agents/shared';
import type { PermissionRole } from '../permissions';

/**
 * Every glob pattern that counts as "the implementation" for `ticket` —
 * `contract.inputs ∪ contract.outputs`, exactly as §13 names them. Returns
 * the raw patterns when no `worktreePath` is given (a caller that just
 * wants "what's on the deny list" for e.g. a report/log line); when given,
 * also resolves each pattern to the absolute paths it currently matches
 * inside the clone (best-effort — a pattern matching nothing yet, because
 * the file doesn't exist in this clone, still stays on the list as a raw
 * pattern so `decideQaRead` can catch a read of it later).
 */
export function qaReadDenyList(ticket: Ticket, worktreePath?: string): string[] {
  const patterns = [...ticket.contract.inputs, ...ticket.contract.outputs];
  if (worktreePath === undefined) return patterns;

  const out = new Set<string>(patterns);
  for (const pattern of patterns) {
    for (const resolved of resolveGlobAgainstClone(pattern, worktreePath)) {
      out.add(resolved);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Glob matching — no dependency: `contract.inputs`/`outputs` are simple
// path globs (§4's own examples: `packages/api/auth/**`,
// `packages/api/auth/jwt.ts`), never full shell-glob syntax (brace
// expansion, character classes). `*` matches within one path segment, `**`
// matches zero or more segments (so `dir/**` covers `dir` itself and
// everything under it, not just its descendants).
// ---------------------------------------------------------------------------

function escapeRegExpLiteral(segment: string): string {
  return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

const DOUBLESTAR_PLACEHOLDER = ' DOUBLESTAR ';

/** Converts one glob pattern into an anchored `RegExp` matching a forward-slash-normalized relative path. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  const body = normalized
    .split('/')
    .map((segment) =>
      segment === '**'
        ? DOUBLESTAR_PLACEHOLDER
        : escapeRegExpLiteral(segment).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'),
    )
    .join('/')
    // A trailing/leading/interior `**` segment absorbs the slash(es) beside
    // it, so `a/**` matches `a` itself as well as `a/b/c`, and `a/**/b`
    // matches `a/b` as well as `a/x/y/b`.
    .replace(new RegExp(`/${DOUBLESTAR_PLACEHOLDER}/`, 'g'), '(?:/.*)?/')
    .replace(new RegExp(`^${DOUBLESTAR_PLACEHOLDER}/`), '(?:.*/)?')
    .replace(new RegExp(`/${DOUBLESTAR_PLACEHOLDER}$`), '(?:/.*)?')
    .replace(new RegExp(`^${DOUBLESTAR_PLACEHOLDER}$`), '.*');
  return new RegExp(`^${body}$`);
}

export function matchesAnyPattern(relPath: string, patterns: readonly string[]): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

/** Best-effort literal-prefix walk of the clone to find files an existing glob pattern currently matches — no extra dependency, no directory-walk library; small clones only (a QA env is a single ticket's worktree). */
function resolveGlobAgainstClone(pattern: string, worktreePath: string): string[] {
  const matches: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === '.git' || entry === 'node_modules') continue;
      const abs = join(dir, entry);
      const rel = relative(worktreePath, abs).split(sep).join('/');
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(abs);
      } else if (matchesAnyPattern(rel, [pattern])) {
        matches.push(abs);
      }
    }
  };
  walk(worktreePath);
  return matches;
}

/**
 * Normalizes `path` (absolute or relative to `worktreePath`) into a
 * forward-slash relative path for pattern matching. A path that resolves
 * outside `worktreePath` is returned normalized-but-unrelated — it will
 * simply never match a contract pattern, which is correct (contract globs
 * only ever name paths inside the ticket's own tree).
 *
 * Exported (review round fix, opus blocker 2): the original wiring sketch
 * at the bottom of this file matched Claude's ABSOLUTE `file_path` directly
 * against `contract.inputs`/`outputs`' repo-relative globs, which never
 * matches — both sides must be resolved to the same (worktree-relative)
 * frame first. `hook/decide.ts` and `permissions/policy-tables.ts` both
 * reuse this resolver (alongside `matchesAnyPattern`) instead of
 * re-deriving path resolution themselves.
 */
export function resolveRelToWorktree(path: string, worktreePath: string): string {
  const abs = isAbsolute(path) ? path : join(worktreePath, path);
  return relative(worktreePath, abs).split(sep).join('/');
}

export interface DecideQaReadContext {
  role: PermissionRole;
  ticket: Ticket;
  worktreePath: string;
}

export type QaReadDecision = { allow: true } | { allow: false; reason: string };

/**
 * The QA-only read gate: denies a `Read`/`Grep`-style access to any path
 * matching `contract.inputs ∪ contract.outputs` for THIS ticket. Roles
 * other than `qa` always allow here (this function only ever narrows the
 * qa role — every other role's read policy is unaffected, per §14's table:
 * "Engineer: own worktree", "Reviewer: worktree via tools").
 */
export function decideQaRead(ctx: DecideQaReadContext, path: string): QaReadDecision {
  if (ctx.role !== 'qa') return { allow: true };
  const relPath = resolveRelToWorktree(path, ctx.worktreePath);
  const patterns = [...ctx.ticket.contract.inputs, ...ctx.ticket.contract.outputs];
  if (matchesAnyPattern(relPath, patterns)) {
    return {
      allow: false,
      reason: 'QA may not read contract inputs/outputs (§13)',
    };
  }
  return { allow: true };
}

/**
 * WIRED (review round fix): `hook/types.ts`'s `HookDecisionContext` carries
 * `denyReadPaths?: string[]` — `hook/service.ts`'s `buildContext` populates
 * it from `qaReadDenyList(ticket)` for `role === 'qa'` (the raw contract
 * patterns, `contract.inputs ∪ outputs` — no need to pre-resolve against the
 * clone since `hook/decide.ts` resolves each candidate path itself via
 * `resolveRelToWorktree` before matching, closing the "absolute vs.
 * repo-relative" bug the first draft of this wiring had). `hook/decide.ts`'s
 * `computeGateVerdict` consults `ctx.denyReadPaths` (via `pathsForToolCall`
 * + `resolveRelToWorktree` + `matchesAnyPattern`, all reused from here)
 * BEFORE the size-gate tier, for every path-bearing built-in tool (`Read`,
 * `Grep`, `Glob`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`) — a
 * role-extension seam (the field is generic per-role data, not QA-specific
 * machinery in `decide.ts` itself) rather than a QA branch hardcoded into
 * the pure decision function.
 *
 * The same `ctx.denyReadPaths` also feeds
 * `permissions/policy-tables.ts`'s `qaBashPathVerdict` (called from
 * `hook/decide.ts`'s `roleToolVerdict`, alongside its existing
 * `decidePermission` call) so `cat`/`head`/`grep` of a contract path is
 * denied the same way a raw `Read` is (§14 Bash rule).
 *
 * `read_summary` (an MCP tool, not a raw Claude tool the PreToolUse hook
 * ever sees) is gated separately: `tools/service.ts`'s `ToolService` takes
 * an optional `pathGuard` — a plain `(ctx, path) => {allow, reason?}`
 * function, no QA-specific knowledge in `tools/service.ts` either — the
 * daemon wires a QA closure over `decideQaRead` at construction (not done
 * in this ticket's own file ownership boundary — `daemon.ts` isn't owned
 * here — but the mechanism itself is real and directly tested against a
 * `ToolService` built with a `pathGuard` in `qa/deny.test.ts`/
 * `tools/service.test.ts`).
 */
