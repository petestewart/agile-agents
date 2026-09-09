/**
 * The policy table (T010, design/agile-agents-design.md §14 "Permissions per
 * role"): one module holding the never-without-human list and each role's
 * allow rules, "so T014/T016 can extend them" (ticket "Tests" paragraph).
 *
 * Every verdict function returns a reason string on deny/hil (never a bare
 * `false`) — "Deny always carries a reason and a pointer" (§14).
 *
 * Review-round rewrite (opus's blocking findings + manager consolidation):
 * a command is now split into `CommandAtom`s (command.ts) — one per
 * `;`/`&&`/`||`/`|`/newline-separated segment, with `sh -c "..."` recursed
 * into — and classified **most-restrictive-atom-wins**: any atom that hits
 * the never-without-human list makes the whole command `hil`; failing that,
 * any atom the role table would deny makes the whole command `deny`; only
 * if every atom is individually allowed does the whole command allow. This
 * is what closes the `git status && git push origin main` /
 * `FOO=1 git push origin main` / `cd sub && git push origin main` /
 * `sh -c "git push origin main"` bypasses.
 */

import * as cmd from './command';
import { isPathInside } from './command';
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
  /** This ticket's id (`TKT-0001`) — the only branch a `push` may target without a human (opus should-fix 4). */
  ticket: string;
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
 * Every path a request needs containment-checked (round-4 review fix:
 * `classified.targetPath` alone is only the first of `toolCall.locations`
 * — a `[inside, outside]` pair must not pass just because the first entry
 * does). Falls back to `[targetPath]` for `rawInput`/title-derived
 * requests, which only ever carry one.
 */
function allTargetPaths(classified: PermissionRequest): string[] {
  if (classified.targetPaths !== undefined) return classified.targetPaths;
  return classified.targetPath !== undefined ? [classified.targetPath] : [];
}

/** The never-without-human verdict for one already-parsed atom, or `undefined` if this atom doesn't match any named category. */
function neverWithoutHumanForAtom(
  atom: cmd.CommandAtom,
  ctx: PolicyContext,
): PolicyVerdict | undefined {
  const { tokens } = atom;

  const parsedGit = cmd.parseGitInvocation(tokens);
  if (parsedGit.cPaths.some((p) => !isPathInside(p, ctx.worktreePath))) {
    return hil('git -C outside the worktree is never automatic — file a hil_request');
  }
  const args = parsedGit.args;
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
      const refspecs = cmd.pushRefspecs(args);
      if (refspecs.length === 0) {
        return hil(
          'push with no explicit branch (current branch/default remote) is never automatic — file a hil_request',
        );
      }
      for (const refspec of refspecs) {
        const branch = cmd.refspecDestBranch(refspec);
        if (!cmd.isTicketBranch(branch, ctx.ticket)) {
          return hil(
            `push to ${branch} (not this ticket's branch) is never automatic — file a hil_request`,
          );
        }
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
  if (cmd.isPipedIntoBareShell(atom)) {
    return hil('piping a remote fetch into a shell is never automatic — file a hil_request');
  }
  if (cmd.isSudo(tokens)) {
    return hil('sudo is never automatic — file a hil_request');
  }
  if (cmd.isChmodRecursive777(tokens)) {
    return hil('chmod -R 777 is never automatic — file a hil_request');
  }

  return undefined;
}

/**
 * Checks the request against the universal never-without-human list.
 * Returns a `hil` verdict when matched, `undefined` when the request isn't
 * one of these named categories (the caller falls through to the role
 * table). Splits `execute` commands into atoms first (see file header) so
 * a shell chain can't smuggle a never-without-human segment past a
 * whitespace-only tokenizer.
 */
export function checkNeverWithoutHuman(
  classified: PermissionRequest,
  ctx: PolicyContext,
): PolicyVerdict | undefined {
  if (classified.toolClass === 'edit') {
    // Every location, not just the first (round-4 review fix — see
    // `allTargetPaths`): a `[safe.txt, .agile/tickets/x.yaml]` pair must
    // still hit these gates.
    const paths = allTargetPaths(classified);
    if (paths.some((p) => cmd.touchesAgileState(p))) {
      return hil('direct writes to .agile/ are never automatic — file a hil_request');
    }
    if (paths.some((p) => cmd.isManifestPath(p))) {
      return hil(
        'editing a dependency manifest/lockfile is never automatic — file a discovery/hil_request',
      );
    }
  }

  if (classified.toolClass === 'execute' && classified.command !== undefined) {
    if (cmd.hasUnsafeShellConstruct(classified.command)) {
      return hil(
        'command substitution/backticks/eval/unbalanced quotes are unclassifiable — file a hil_request',
      );
    }
    for (const atom of cmd.parseCommandIntoAtoms(classified.command)) {
      const verdict = neverWithoutHumanForAtom(atom, ctx);
      if (verdict !== undefined) return verdict;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Role tables (§14's table, one function per role). Each assumes
// `checkNeverWithoutHuman` already ran and returned nothing.
// ---------------------------------------------------------------------------

function engineerExecuteVerdict(command: string, ctx: PolicyContext): PolicyVerdict {
  for (const atom of cmd.parseCommandIntoAtoms(command)) {
    if (cmd.hasRedirectionOrTee(atom.tokens)) {
      // Every *non-benign* redirection target must resolve inside the
      // worktree (review round 2: a single `>` used to be the only spelling
      // checked — `1>`, `2>`, `&>`, and a second `>` later in the same atom
      // all slipped through). `tee`, an unresolvable target, and a process
      // substitution (`<(...)`) have no path to verify, so they deny
      // outright rather than guess. Benign targets (`/dev/null`, fd-dup
      // `&1`/`&2`, fd-close `&-`) are not writes and need no containment
      // check at all (T029: `npm test 2>&1`, `cmd 2>/dev/null`,
      // `cmd >/dev/null` no longer over-deny here).
      const hasTee = atom.tokens.includes('tee');
      const hasProcessSub = atom.tokens.some((t) => t.startsWith('<('));
      const unresolved = cmd.hasUnresolvedRedirection(atom.tokens);
      const targets = cmd.redirectionTargets(atom.tokens);
      if (
        hasTee ||
        hasProcessSub ||
        unresolved ||
        targets.some((t) => !isPathInside(t, ctx.worktreePath))
      ) {
        return deny('redirected output escapes the worktree (or uses tee/process substitution)');
      }
      // Every non-benign redirection target is inside the worktree (or
      // every redirection here was benign) — fall through and still
      // classify the underlying command below. A safe redirect target does
      // not by itself make the command it's attached to allowed (e.g.
      // `rm -rf secret > <worktree>/out.log` must still be denied for not
      // being a repo script or git invocation).
    }
    if (cmd.isRepoScriptCommand(atom.tokens)) continue;
    if (cmd.gitArgs(atom.tokens) !== undefined) {
      // Any git invocation inside the worktree that isn't on the
      // never-without-human list above (push/force-push/branch-delete/
      // reset --hard already handled) is the engineer's own ticket
      // branch work — "git inside the worktree except the never list" (ticket).
      continue;
    }
    return deny(`${atom.tokens[0] ?? command} is not an allowed command for the engineer role`);
  }
  return ALLOW;
}

function engineerVerdict(classified: PermissionRequest, ctx: PolicyContext): PolicyVerdict {
  switch (classified.toolClass) {
    case 'read':
      // "own worktree; state via daemon" (§14) — reads are never gated by
      // ACP anyway (spike-findings §A), but answer consistently if asked.
      return ALLOW;
    case 'edit': {
      // Every path must resolve inside the worktree (round-4 review fix,
      // R4-1): a request with an inside path first and an outside one
      // second must not read as "verified" once the first one passes.
      const paths = allTargetPaths(classified);
      if (paths.length === 0) {
        return deny(
          'cannot verify the edit target is inside the worktree — use read_summary/report the path',
        );
      }
      const outside = paths.find((p) => !isPathInside(p, ctx.worktreePath));
      return outside === undefined ? ALLOW : deny(`edit target ${outside} is outside the worktree`);
    }
    case 'execute':
      if (classified.command === undefined) {
        // DESIGN-GAP (manager decision, overriding the reviewer's
        // suggested `hil`): a `hil` here would flood the human queue with
        // every generic "Terminal"-titled request a vendor sends without
        // rawInput — every exec this policy can't read a command for,
        // benign or not. `deny` is recoverable (the model gets a reason
        // and a pointer) and keeps the human queue for requests this
        // layer actually understands. Command-level enforcement for
        // exactly this "we can't see the command" case is T009's
        // PreToolUse hook's job (see index.ts's file header) — it
        // provably carries `tool_input.command` (spike-findings §B),
        // this tier does not.
        return deny(
          'execute request carries no command to classify at this tier — retry via the hook-gated path (T009) with a clearer command',
        );
      }
      return engineerExecuteVerdict(classified.command, ctx);
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

const REVIEWER_READ_ONLY_GIT_SUBCOMMANDS = new Set(['diff', 'log', 'show', 'status']);
const REVIEWER_PLAIN_READ_ONLY_TOOLS = new Set(['grep', 'rg', 'cat', 'ls', 'wc']);

/**
 * `sed`/`find` are only read-only in a subset of their invocations — `sed
 * -i` and `find … -delete`/`-exec` are write primitives (opus blocking
 * finding 2), so they're gated on flags rather than allowed/dropped
 * wholesale.
 */
/** `sed -i`/`-i.bak`/`-ibak` (short form, review round 1) and `--in-place`/`--in-place=.bak` (long form, review round 2 — `t.startsWith('-i')` alone never matched a `--`-prefixed flag) are all in-place-edit forms. */
function isSedInPlace(tokens: string[]): boolean {
  return tokens.some(
    (t) => t === '-i' || t.startsWith('-i') || t === '--in-place' || t.startsWith('--in-place='),
  );
}

function isReviewerSafeTool(tokens: string[]): boolean {
  const head = tokens[0];
  if (head === undefined) return false;
  if (REVIEWER_PLAIN_READ_ONLY_TOOLS.has(head)) return true;
  if (head === 'sed') return !isSedInPlace(tokens);
  if (head === 'find')
    return !tokens.some((t) => t === '-delete' || t === '-exec' || t === '-execdir');
  // `perl -i ...` and `gawk -i inplace ...` are also in-place rewrites
  // (review round 2, "if cheap") — neither `perl` nor `gawk`/`awk` is in
  // `REVIEWER_PLAIN_READ_ONLY_TOOLS` or has a case above, so they already
  // fall through to `false` (denied) regardless of flags. No extra check
  // is needed unless one of them is ever added to the allow-list — see
  // `command.test.ts` for a locked-in regression covering both.
  return false;
}

function reviewerExecuteVerdict(command: string): PolicyVerdict {
  for (const atom of cmd.parseCommandIntoAtoms(command)) {
    // Benign redirects (`/dev/null`, fd-dup/close) write nothing, so
    // `git diff 2>/dev/null` is a read like any other `git diff` (T029);
    // tee, process substitution, an unresolved target, or a real-file
    // target are still denied as write primitives.
    if (cmd.hasWritingRedirectionOrTee(atom.tokens)) {
      return deny('reviewer role denies exec with redirection/tee — those are write primitives');
    }
    const args = cmd.gitArgs(atom.tokens);
    const isReadOnlyGit =
      args !== undefined && REVIEWER_READ_ONLY_GIT_SUBCOMMANDS.has(args[0] ?? '');
    if (isReadOnlyGit) continue;
    if (isReviewerSafeTool(atom.tokens)) continue;
    return deny(
      'reviewer role denies all exec except read-only tools (git diff/log/show, grep, …)',
    );
  }
  return ALLOW;
}

function reviewerVerdict(classified: PermissionRequest): PolicyVerdict {
  switch (classified.toolClass) {
    case 'read':
      // "worktree via tools, rules, oracle" — read-only tools (§14).
      return ALLOW;
    case 'edit':
      return deny('reviewer role denies all writes — use read-only tools');
    case 'execute':
      if (classified.command === undefined) {
        return deny('reviewer role denies exec with no command to classify');
      }
      return reviewerExecuteVerdict(classified.command);
    case 'fetch':
      return deny('reviewer role has no network access');
    default:
      return deny(
        `unknown tool kind${classified.title ? ` (${classified.title})` : ''} — safe default deny`,
      );
  }
}

function qaExecuteVerdict(command: string): PolicyVerdict {
  // "anything in the env" (§14) — exec is bounded by the QA env itself (a
  // throwaway clone/container, §13), not by a path check here. Redirection
  // and tee are still write primitives regardless of role (opus blocking
  // finding 2 names reviewer/QA together) — except benign forms
  // (`/dev/null`, fd-dup/close), which write nothing (T029).
  for (const atom of cmd.parseCommandIntoAtoms(command)) {
    if (cmd.hasWritingRedirectionOrTee(atom.tokens)) {
      return deny('QA role denies exec with redirection/tee — those are write primitives');
    }
  }
  return ALLOW;
}

function qaVerdict(classified: PermissionRequest): PolicyVerdict {
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
      if (classified.command === undefined) return ALLOW;
      return qaExecuteVerdict(classified.command);
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
      return qaVerdict(classified);
  }
}
