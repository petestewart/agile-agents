/**
 * The policy table (T010, design/agile-agents-design.md §14 "Permissions per
 * role"): one module holding the never-without-human list and each role's
 * allow rules, "so T014/T016 can extend them" (ticket "Tests" paragraph).
 *
 * Every verdict function returns a reason string on deny/hil (never a bare
 * `false`) — "Deny always carries a reason and a pointer" (§14).
 */

import { isPathInside, tokenize } from './command';
import * as cmd from './command';
import type { PermissionRequest, PermissionRole } from './types';

export type PolicyVerdict =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'hil'; reason: string };

const ALLOW: PolicyVerdict = { action: 'allow' };
function deny(reason: string): PolicyVerdict {
  return { action: 'deny', reason };
}
function hil(reason: string): PolicyVerdict {
  return { action: 'hil', reason };
}

export interface PolicyContext {
  role: PermissionRole;
  worktreePath: string;
}

// ---------------------------------------------------------------------------
// Never-without-human (§14 "Never without a human"). Checked before any
// role table, for every role: nobody's allow-list can override these.
// ---------------------------------------------------------------------------

/**
 * A handful of well-known package registry hosts, for the engineer's
 * "package registries only" network allowance (§14). DESIGN-GAP: the design
 * names no exhaustive list; this is a starter set matching the ticket's
 * "package registries" language, extensible here rather than by relaxing
 * the check some other way.
 */
export const PACKAGE_REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'npmjs.org',
  'registry.yarnpkg.com',
  'jsr.io',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
] as const;

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export function isPackageRegistryUrl(url: string | undefined): boolean {
  const host = hostOf(url);
  return (
    host !== undefined && PACKAGE_REGISTRY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  );
}

/**
 * Checks the request against the universal never-without-human list.
 * Returns a `hil` verdict when matched, `undefined` when the request isn't
 * one of these named categories (the caller falls through to the role
 * table).
 */
export function checkNeverWithoutHuman(
  classified: PermissionRequest,
  ctx: PolicyContext,
): PolicyVerdict | undefined {
  if (classified.toolClass === 'edit' && cmd.touchesAgileState(classified.targetPath)) {
    return hil('direct writes to .agile/ are never automatic — file a hil_request');
  }

  if (classified.toolClass === 'execute' && classified.command !== undefined) {
    const tokens = tokenize(classified.command);
    const args = cmd.gitArgs(tokens);

    if (args !== undefined) {
      if (cmd.isForcePush(args)) {
        return hil('force-push is never automatic — file a hil_request');
      }
      if (cmd.isBranchDelete(args)) {
        return hil('branch deletion is never automatic — file a hil_request');
      }
      if (cmd.isGitResetHard(args)) {
        return hil('git reset --hard is never automatic — file a hil_request');
      }
      if (args[0] === 'push') {
        const branch = cmd.pushTargetBranch(args);
        if (!cmd.isTicketBranch(branch)) {
          return hil(
            `push to ${branch ?? 'the current branch'} (not the ticket's tkt/* branch) is never automatic — file a hil_request`,
          );
        }
      }
    }

    if (cmd.isNewDependencyInstall(tokens)) {
      return hil('installing a new dependency is never automatic — file a discovery/hil_request');
    }
    if (cmd.isRmMinusRf(tokens)) {
      const outside = cmd.rmTargets(tokens).some((t) => !isPathInside(t, ctx.worktreePath));
      if (outside) {
        return hil('rm -rf outside the worktree is never automatic — file a hil_request');
      }
    }
    if (cmd.isPipeToShell(classified.command)) {
      return hil('piping a remote fetch into a shell is never automatic — file a hil_request');
    }
    if (cmd.isSudo(tokens)) {
      return hil('sudo is never automatic — file a hil_request');
    }
    if (cmd.isChmodRecursive777(tokens)) {
      return hil('chmod -R 777 is never automatic — file a hil_request');
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Role tables (§14's table, one function per role). Each assumes
// `checkNeverWithoutHuman` already ran and returned nothing.
// ---------------------------------------------------------------------------

function engineerVerdict(classified: PermissionRequest, ctx: PolicyContext): PolicyVerdict {
  switch (classified.toolClass) {
    case 'read':
      // "own worktree; state via daemon" (§14) — reads are never gated by
      // ACP anyway (spike-findings §A), but answer consistently if asked.
      return ALLOW;
    case 'edit':
      if (classified.targetPath === undefined) {
        return deny(
          'cannot verify the edit target is inside the worktree — use read_summary/report the path',
        );
      }
      return isPathInside(classified.targetPath, ctx.worktreePath)
        ? ALLOW
        : deny(`edit target ${classified.targetPath} is outside the worktree`);
    case 'execute': {
      if (classified.command === undefined) {
        return deny('execute request carries no command to classify');
      }
      const tokens = tokenize(classified.command);
      if (cmd.isRepoScriptCommand(tokens)) return ALLOW;
      if (cmd.gitArgs(tokens) !== undefined) {
        // Any git invocation inside the worktree that isn't on the
        // never-without-human list above (push/force-push/branch-delete/
        // reset --hard already handled) is the engineer's own ticket
        // branch work — "git inside the worktree except the never list" (ticket).
        return ALLOW;
      }
      return deny(
        `${tokens[0] ?? classified.command} is not an allowed command for the engineer role`,
      );
    }
    case 'fetch':
      return isPackageRegistryUrl(classified.url)
        ? ALLOW
        : deny(`${classified.url ?? 'this network request'} is not a package registry`);
    default:
      return deny(
        `unknown tool kind${classified.title ? ` (${classified.title})` : ''} — safe default deny`,
      );
  }
}

function reviewerVerdict(classified: PermissionRequest): PolicyVerdict {
  switch (classified.toolClass) {
    case 'read':
      // "worktree via tools, rules, oracle" — read-only tools (§14).
      return ALLOW;
    case 'edit':
      return deny('reviewer role denies all writes — use read-only tools');
    case 'execute': {
      if (classified.command === undefined) {
        return deny('reviewer role denies exec with no command to classify');
      }
      const tokens = tokenize(classified.command);
      const args = cmd.gitArgs(tokens);
      const isReadOnlyGit =
        args !== undefined && ['diff', 'log', 'show', 'status'].includes(args[0] ?? '');
      const isReadOnlyTool = ['grep', 'rg', 'cat', 'ls', 'find', 'wc', 'sed'].includes(
        tokens[0] ?? '',
      );
      if (isReadOnlyGit || isReadOnlyTool) return ALLOW;
      return deny(
        'reviewer role denies all exec except read-only tools (git diff/log/show, grep, …)',
      );
    }
    case 'fetch':
      return deny('reviewer role has no network access');
    default:
      return deny(
        `unknown tool kind${classified.title ? ` (${classified.title})` : ''} — safe default deny`,
      );
  }
}

function qaVerdict(classified: PermissionRequest, ctx: PolicyContext): PolicyVerdict {
  switch (classified.toolClass) {
    case 'read':
      // "env minus contract.inputs/outputs" (§14) — the contract-scoped
      // exclusion is enforced by whatever hands QA its tool permissions
      // (§13: "QA's tool permissions deny Read/grep on contract.outputs and
      // contract.inputs"), not by this generic ACP layer, which has no
      // contract in scope. DESIGN-GAP, flagged for T018/whoever wires QA's
      // tool-level permissions.
      return ALLOW;
    case 'edit':
      // "own test files in the env" (§14) vs "deny edits to source"
      // (ticket). Distinguishing a QA-owned test file from source needs
      // contract awareness this layer doesn't have — deny by default is
      // the safe reading of "deny edits to source". DESIGN-GAP, same as above.
      return deny('QA role denies edits to source — write test files only, via a dedicated tool');
    case 'execute':
      // "anything in the env" (§14) — exec is bounded by the QA env itself
      // (a throwaway clone/container, §13), not by a path check here.
      return ALLOW;
    case 'fetch':
      // "env base URL" (§14). No base URL is threaded into this policy
      // layer yet (DecisionContext has no envBaseUrl field) — treat as
      // outside the allowlist until one is, rather than allow blindly.
      return hil(
        'QA network access is scoped to the env base URL — file a hil_request until env base URL is wired in',
      );
    default:
      return deny(
        `unknown tool kind${classified.title ? ` (${classified.title})` : ''} — safe default deny`,
      );
  }
}

export function roleVerdict(
  role: PermissionRole,
  classified: PermissionRequest,
  ctx: PolicyContext,
): PolicyVerdict {
  switch (role) {
    case 'engineer':
      return engineerVerdict(classified, ctx);
    case 'reviewer':
      return reviewerVerdict(classified);
    case 'qa':
      return qaVerdict(classified, ctx);
  }
}
