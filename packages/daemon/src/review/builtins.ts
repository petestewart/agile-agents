/**
 * Review-owned tool verbs, registered the same shape `tools/builtins.ts`
 * uses (`BuiltinToolInfo`: `{name, description, inputSpec, handler(deps,
 * ctx, input)}`) so `ToolService` can fold them into its `BUILTIN_TOOLS`
 * list without a different registration mechanism (T016 Session override —
 * "the `diff_summary` tool implemented inside `src/review/` and registered
 * through the same mechanism `tools/builtins.ts` uses").
 *
 * WIRING GAP (this ticket owns only `src/review/**`, not `tools/**`): today
 * nothing calls `registerReviewTools` — `ToolService.callTool` (`tools/
 * service.ts`) only ever consults `BUILTIN_TOOLS` (from `tools/builtins.ts`)
 * and its own `registry` array, neither of which this ticket may edit. The
 * exact change needed once T016 is reviewed:
 *
 *   1. `tools/service.ts`'s `ToolServiceOptions` gains an optional
 *      `extraBuiltins?: BuiltinToolInfo[]` (or the daemon wiring passes
 *      `registerReviewTools(...)`'s result pre-concatenated with
 *      `BUILTIN_TOOLS` when constructing `ToolService`).
 *   2. `ToolService.listTools()`/`callTool()` search that combined list
 *      instead of `BUILTIN_TOOLS` alone.
 *   3. Whatever constructs `ToolService` for a reviewer's MCP bridge (the
 *      `agile mcp --agent reviewer-N --ticket ...` CLI path, T011's
 *      architecture decision) passes `repoRoot` through to
 *      `registerReviewTools`'s deps.
 *
 * Until that lands, `diff_summary` is fully implemented and unit-tested
 * here (see `diff-summary.test.ts`/`protocol.test.ts`) but not yet reachable
 * over a live MCP call.
 */

import { isAbsolute, join } from 'node:path';
import type { TicketId } from '@agile-agents/shared';
import type { Bus } from '../bus/bus';
import { INTEGRATION_BRANCH, ticketBranch } from '../runner/worktrees';
import type { StateStore } from '../store/store';
import type { ToolCallContext } from '../tools/types';
import { runDiffSummary } from './diff-summary';

export class ReviewToolError extends Error {}

export interface ReviewToolDeps {
  store: StateStore;
  bus: Bus;
  /** Repo root — the raw-diff host-local cache root, and the fallback worktree when a ticket has none on record yet (same contract as `tools/service.ts`'s `resolveWorktree`). */
  repoRoot: string;
}

/** Real per-field shape, mirroring `tools/builtins.ts`'s `BuiltinToolInfo` — kept as a structurally-identical local type rather than importing that module's interface, so this file has no dependency edge into `tools/**` (a directory this ticket doesn't own) beyond the read-only `ToolCallContext`/schema types every tool already shares. */
export interface ReviewToolInputFieldSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';
  optional: boolean;
}
export type ReviewToolInputSpec = Record<string, ReviewToolInputFieldSpec>;

export interface ReviewToolInfo {
  name: string;
  description: string;
  inputSpec: ReviewToolInputSpec;
  handler: (deps: ReviewToolDeps, ctx: ToolCallContext, input: unknown) => Promise<unknown>;
}

/** Same fallback `tools/service.ts`'s `resolveWorktree` uses: the ticket's recorded worktree, or `repoRoot` when it has none yet. */
function resolveWorktree(deps: ReviewToolDeps, ctx: ToolCallContext): string {
  if (ctx.ticket) {
    try {
      const ticket = deps.store.getTicket(ctx.ticket as TicketId);
      if (ticket.worktree) {
        return isAbsolute(ticket.worktree) ? ticket.worktree : join(deps.repoRoot, ticket.worktree);
      }
    } catch {
      // No such ticket yet, or no worktree recorded — fall back below.
    }
  }
  return deps.repoRoot;
}

async function diffSummaryHandler(
  deps: ReviewToolDeps,
  ctx: ToolCallContext,
  _input: unknown,
): Promise<unknown> {
  if (!ctx.ticket) {
    throw new ReviewToolError('diff_summary: this session has no ticket context');
  }
  const ticket = deps.store.getTicket(ctx.ticket as TicketId);
  const worktree = resolveWorktree(deps, ctx);
  return runDiffSummary({
    worktree,
    base: INTEGRATION_BRANCH,
    head: ticketBranch(deps.repoRoot, ticket),
    repoRoot: deps.repoRoot,
  });
}

export const REVIEW_BUILTIN_TOOLS: readonly ReviewToolInfo[] = [
  {
    name: 'diff_summary',
    description:
      "Changed files, best-effort symbols, and risk notes for the caller's ticket vs integration — never the raw diff (§7).",
    inputSpec: {},
    handler: diffSummaryHandler,
  },
];

/** Returns the tools this ticket owns, ready to fold into `ToolService`'s builtin list once the wiring gap above is closed. */
export function registerReviewTools(_deps: ReviewToolDeps): readonly ReviewToolInfo[] {
  return REVIEW_BUILTIN_TOOLS;
}
