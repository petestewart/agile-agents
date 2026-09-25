/**
 * The policy table (agile-agents-design §14 "Permissions per role"): the
 * never-without-human list and each role's allow rules. Every deny/hil
 * carries a reason.
 *
 * A command is split into `CommandAtom`s (one per `;`/`&&`/`||`/`|`/newline
 * segment, `sh -c "..."` recursed into) and classified
 * most-restrictive-atom-wins: any never-without-human atom makes it `hil`,
 * else any denied atom makes it `deny`, else it is allowed. That closes
 * `git status && git push origin main`, `sh -c "git push origin main"` and
 * the like.
 */

import { resolve } from 'node:path';
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
  /** T213: where a read may reach beyond the worktree (visible registered repos). */
  readRoots?: readonly string[];
  /** T213: never readable unless inside the worktree: private repos not shared with the node, and the agile home. */
  hiddenRoots?: readonly string[];
}

/**
 * T213: the deny reason for a read of `path` (absolute, or relative to the
 * worktree), or `undefined` when it may be read. An allow-list: the own
 * worktree (or session dir), then any `readRoots` path not under a hidden root.
 */
export function readDenyReason(
  raw: string,
  ctx: Pick<PolicyContext, 'worktreePath' | 'readRoots' | 'hiddenRoots'>,
): string | undefined {
  const path = resolve(ctx.worktreePath, raw);
  if (isPathInside(path, ctx.worktreePath)) return undefined;
  // The deepest root wins (as P13's visibility check): a readable repo nested
  // inside a hidden one stays readable.
  const readable = (ctx.readRoots ?? []).filter((root) => isPathInside(path, root));
  const hidden = (ctx.hiddenRoots ?? []).filter((root) => isPathInside(path, root));
  if (hidden.some((h) => !readable.some((r) => r !== h && isPathInside(r, h)))) {
    return `${raw} is in the agile home or a private repo this node's project cannot read`;
  }
  if (readable.length > 0) return undefined;
  return `${raw} is outside the worktree and every repo this node can read`;
}

// Never-without-human (§14 "Never without a human"). Checked before any
// role table, for every role: nobody's allow-list can override these.

/** Package registry hosts: the engineer's "package registries only" network allowance (§14). A starter set. */
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
 * Every path a request needs containment-checked: all of
 * `toolCall.locations`, not just the first (an `[inside, outside]` pair
 * must not pass on its first entry).
 */
function allTargetPaths(classified: PermissionRequest): string[] {
  if (classified.targetPaths !== undefined) return classified.targetPaths;
  return classified.targetPath !== undefined ? [classified.targetPath] : [];
}

/** The never-without-human verdict for one atom, or `undefined` if it matches no category. */
function neverWithoutHumanForAtom(
  atom: cmd.CommandAtom,
  ctx: PolicyContext,
): PolicyVerdict | undefined {
  const { tokens } = atom;

  // `git -C` outside the worktree and pushes to protected branches are the
  // `no_worktree_escape`/`no_push_protected` built-in pattern rules (§5.4),
  // so a repo can retire or rescope them. The rest of the list stays here.
  const args = cmd.parseGitInvocation(tokens).args;
  if (args !== undefined) {
    if (cmd.isForcePush(args)) {
      return hil('force-push is never automatic');
    }
    if (cmd.isBranchDelete(args)) {
      return hil('branch deletion is never automatic');
    }
    if (cmd.isGitResetHard(args)) {
      return hil('git reset --hard is never automatic');
    }
  }

  if (cmd.isNewDependencyInstall(tokens)) {
    return hil('installing a new dependency is never automatic');
  }
  if (cmd.isRmMinusRf(tokens)) {
    const outside = cmd.rmTargets(tokens).some((t) => !isPathInside(t, ctx.worktreePath));
    if (outside) {
      return hil('rm -rf outside the worktree is never automatic');
    }
  }
  if (cmd.isPipedIntoBareShell(atom)) {
    return hil('piping a remote fetch into a shell is never automatic');
  }
  if (cmd.isSudo(tokens)) {
    return hil('sudo is never automatic');
  }
  if (cmd.isChmodRecursive777(tokens)) {
    return hil('chmod -R 777 is never automatic');
  }

  return undefined;
}

/**
 * The universal never-without-human list: `hil` when matched, `undefined`
 * otherwise (the caller falls through to the role table). Commands are
 * split into atoms first so a chain can't smuggle a segment past it.
 */
export function checkNeverWithoutHuman(
  classified: PermissionRequest,
  ctx: PolicyContext,
): PolicyVerdict | undefined {
  if (classified.toolClass === 'edit') {
    // Every location, not just the first.
    const paths = allTargetPaths(classified);
    if (paths.some((p) => cmd.touchesAgileState(p))) {
      return hil('direct writes to .agile/ are never automatic');
    }
    if (paths.some((p) => cmd.isManifestPath(p))) {
      return hil('editing a dependency manifest/lockfile is never automatic');
    }
  }

  if (classified.toolClass === 'execute' && classified.command !== undefined) {
    if (cmd.hasUnsafeShellConstruct(classified.command)) {
      return hil('command substitution/backticks/eval/unbalanced quotes are unclassifiable');
    }
    for (const atom of cmd.parseCommandIntoAtoms(classified.command)) {
      const verdict = neverWithoutHumanForAtom(atom, ctx);
      if (verdict !== undefined) return verdict;
    }
  }

  return undefined;
}

// Role tables (§14's table, one function per role). Each assumes
// `checkNeverWithoutHuman` already ran and returned nothing.

// Engineer benign commands: everyday commands that are neither a repo
// script nor git. Checked after those have had first claim, and only for
// atoms that passed the never-without-human list and the redirection gate.

/** No path worth containment-checking: no path argument, only an exit status, literal argv, or stdin. */
const ENGINEER_BENIGN_NO_PATH_TOOLS = new Set([
  'echo',
  'printf',
  'pwd',
  'which',
  'date',
  'true',
  'false',
  'test',
  '[',
  'tr',
]);

/** Commands whose non-flag positional arguments are every path they touch (`cmd.benignPathArgs`). */
const ENGINEER_BENIGN_PATH_TOOLS = new Set([
  'cat',
  'ls',
  'mkdir',
  'cp',
  'mv',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'touch',
  'diff',
]);

/** T213: of those, the ones that only read, so any `readRoots` path is fine (`sort -o` writes). */
const ENGINEER_READ_ONLY_PATH_TOOLS = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'cut', 'diff']);

/**
 * Every path must resolve inside the worktree after `~` expansion
 * (`cmd.resolveTargetPath`); a `$`, backtick or `~user` is unclassifiable
 * and routes to `hil`, never a guessed allow.
 */
function verifyBenignPaths(paths: string[], ctx: PolicyContext, reads = false): PolicyVerdict {
  for (const raw of paths) {
    const resolved = cmd.resolveTargetPath(raw);
    if (!resolved.safe) {
      return hil(
        `"${raw}" contains an unresolved shell variable/backtick/home-directory reference`,
      );
    }
    if (reads) {
      const reason = readDenyReason(resolved.path, ctx);
      if (reason !== undefined) return deny(reason);
    } else if (!isPathInside(resolved.path, ctx.worktreePath)) {
      return deny(`${raw} is outside the worktree`);
    }
  }
  return ALLOW;
}

/** The benign-command verdict for one atom, or `undefined` if it is none of these shapes (the caller denies). */
function engineerBenignCommandVerdict(
  atom: cmd.CommandAtom,
  ctx: PolicyContext,
): PolicyVerdict | undefined {
  const { tokens } = atom;
  const head = tokens[0];

  if (head === undefined) {
    // A bare wrapper (`env`, `nohup`, ...) stripped to nothing: inert.
    return ALLOW;
  }

  if (ENGINEER_BENIGN_NO_PATH_TOOLS.has(head)) return ALLOW;

  const dlx = cmd.parseDlxInvocation(tokens);
  if (dlx !== undefined) {
    // Allowed only when the bin is a real repo-local executable
    // (`cmd.isRepoLocalBin`); otherwise it is new-dependency execution, like
    // `bun add`. Fetch-forcing flags and `dlx` (which always fetches) are
    // always `hil`.
    if (dlx.forcesInstall) {
      return hil(
        `"${dlx.bin}" forces a package install/global run (-p/--package/-y/--yes/-g/--global)`,
      );
    }
    if (dlx.neverLocal) {
      return hil(
        `"${dlx.bin}" via dlx always fetches into a temporary store, never the local node_modules/.bin`,
      );
    }
    return cmd.isRepoLocalBin(dlx.bin, ctx.worktreePath)
      ? ALLOW
      : hil(`"${dlx.bin}" is not an existing repo-local bin (node_modules/.bin)`);
  }

  if (head === 'find') {
    if (cmd.isFindWriteInvocation(tokens)) return undefined; // write primitives: not benign
    return verifyBenignPaths(cmd.findSearchRoots(tokens), ctx, true);
  }

  if (head === 'grep' || head === 'rg') {
    // `rg --pre <cmd>` runs a command on every file: not a read.
    if (runsPreprocessor(tokens)) return undefined;
    return verifyBenignPaths(
      [...cmd.grepPathArgs(tokens), ...cmd.flagPathValues(tokens)],
      ctx,
      true,
    );
  }

  const scriptPath = cmd.scriptExecutionPath(tokens);
  if (scriptPath !== undefined) {
    return verifyBenignPaths([scriptPath], ctx);
  }

  if (ENGINEER_BENIGN_PATH_TOOLS.has(head)) {
    return verifyBenignPaths(
      [...cmd.benignPathArgs(tokens), ...cmd.flagPathValues(tokens)],
      ctx,
      ENGINEER_READ_ONLY_PATH_TOOLS.has(head),
    );
  }

  return undefined;
}

function engineerExecuteVerdict(command: string, ctx: PolicyContext): PolicyVerdict {
  for (const atom of cmd.parseCommandIntoAtoms(command)) {
    if (cmd.hasRedirectionOrTee(atom.tokens)) {
      // Every non-benign redirection target (`>`, `1>`, `2>`, `&>`, a second
      // `>`, ...) must resolve inside the worktree. `tee`, an unresolvable
      // target and `<(...)` have no path to verify and deny outright.
      // Benign targets (`/dev/null`, `&1`, `&-`) are not writes.
      const hasTee = atom.tokens.includes('tee');
      const hasProcessSub = atom.tokens.some((t) => t.startsWith('<('));
      const unresolved = cmd.hasUnresolvedRedirection(atom.tokens);
      if (hasTee || hasProcessSub || unresolved) {
        return deny('redirected output escapes the worktree (or uses tee/process substitution)');
      }
      // Same `~`/`$VAR`/backtick resolution as any path argument
      // (`echo hi > ~/.bashrc` must not slip through).
      for (const raw of cmd.redirectionTargets(atom.tokens)) {
        const resolved = cmd.resolveTargetPath(raw);
        if (!resolved.safe) {
          return hil(
            `"${raw}" contains an unresolved shell variable/backtick/home-directory reference`,
          );
        }
        if (!isPathInside(resolved.path, ctx.worktreePath)) {
          return deny('redirected output escapes the worktree (or uses tee/process substitution)');
        }
      }
      // A safe redirect doesn't make the command allowed: still classify it.
    }
    if (cmd.isRepoScriptCommand(atom.tokens)) continue;
    if (cmd.gitArgs(atom.tokens) !== undefined) {
      // Any git not on the never-without-human list: the worker's own branch work.
      continue;
    }
    const benign = engineerBenignCommandVerdict(atom, ctx);
    if (benign !== undefined) {
      if (benign.action === 'allow') continue;
      return benign;
    }
    return deny(`${atom.tokens[0] ?? command} is not an allowed command for the engineer role`);
  }
  return ALLOW;
}

function engineerVerdict(classified: PermissionRequest, ctx: PolicyContext): PolicyVerdict {
  switch (classified.toolClass) {
    case 'read':
      // Reads are never gated by ACP (spike-findings §A), but answer consistently.
      return ALLOW;
    case 'edit': {
      // Every path must resolve inside the worktree, not just the first.
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
        // `deny`, not `hil`: a vendor's generic "Terminal" request with no
        // rawInput would otherwise flood the human queue. The PreToolUse
        // hook, which does see `tool_input.command`, enforces these.
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
/** Plus the read-only part of the engineer's benign table. */
const REVIEWER_PLAIN_READ_ONLY_TOOLS = new Set([
  'grep',
  'rg',
  'cat',
  'ls',
  'wc',
  'head',
  'tail',
  'diff',
  'pwd',
  'which',
]);

/** `sed -i`, `-i.bak`, `--in-place[=.bak]`: in-place edits, so `sed` is gated on flags. */
function isSedInPlace(tokens: string[]): boolean {
  return tokens.some(
    (t) => t === '-i' || t.startsWith('-i') || t === '--in-place' || t.startsWith('--in-place='),
  );
}

/** `rg --pre`/`--pre-glob`: a preprocessor command run per file. */
function runsPreprocessor(tokens: string[]): boolean {
  return tokens.some((t) => t === '--pre' || t.startsWith('--pre=') || t.startsWith('--pre-glob'));
}

function isReviewerSafeTool(tokens: string[]): boolean {
  const head = tokens[0];
  if (head === undefined) return false;
  if ((head === 'rg' || head === 'grep') && runsPreprocessor(tokens)) return false;
  if (REVIEWER_PLAIN_READ_ONLY_TOOLS.has(head)) return true;
  if (head === 'sed') return !isSedInPlace(tokens);
  if (head === 'find')
    // The engineer's `find` write-primitive set, so both roles deny the same.
    return !cmd.isFindWriteInvocation(tokens);
  // `perl -i` and `gawk -i inplace` fall through to `false`: neither is on
  // the allow-list (a regression test in `command.test.ts` locks that in).
  return false;
}

function reviewerExecuteVerdict(command: string): PolicyVerdict {
  for (const atom of cmd.parseCommandIntoAtoms(command)) {
    // Benign redirects write nothing (`git diff 2>/dev/null` is a read);
    // any other redirection or tee is a write primitive.
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
      // Read-only tools (§14).
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

/**
 * P20 (T280): a coordinator's redirect writes land in its scratch session
 * dir (`ctx.worktreePath`) or nowhere; `tee`, process substitution and an
 * unresolvable target deny.
 */
function coordinatorRedirectVerdict(tokens: string[], ctx: PolicyContext): PolicyVerdict {
  if (!cmd.hasWritingRedirectionOrTee(tokens)) return ALLOW;
  if (tokens.includes('tee') || tokens.some((t) => t.startsWith('<('))) {
    return deny('coordinator role denies tee/process substitution — write files with Write');
  }
  if (cmd.hasUnresolvedRedirection(tokens)) {
    return deny('coordinator role denies a redirect it cannot resolve');
  }
  for (const raw of cmd.redirectionTargets(tokens)) {
    const resolved = cmd.resolveTargetPath(raw);
    if (!resolved.safe || !isPathInside(resolved.path, ctx.worktreePath)) {
      return deny('coordinator role writes only inside its session dir');
    }
  }
  return ALLOW;
}

/** T305: a read scope is set (the Director's, or the hook's T213 one). */
function hasReadScope(ctx: PolicyContext): boolean {
  return ctx.readRoots !== undefined || ctx.hiddenRoots !== undefined;
}

/**
 * T305 (P20): under a read scope, every path-like argument of a coordinator's
 * command must be readable (`readDenyReason`); an unresolvable one denies.
 */
function coordinatorScopedReads(tokens: string[], ctx: PolicyContext): PolicyVerdict {
  if (!hasReadScope(ctx)) return ALLOW;
  for (const raw of tokens.slice(1)) {
    if (!(raw.includes('/') || raw.startsWith('.') || raw.startsWith('~'))) continue;
    const resolved = cmd.resolveTargetPath(raw);
    if (!resolved.safe) return deny(`coordinator role cannot resolve the path "${raw}"`);
    const reason = readDenyReason(resolved.path, ctx);
    if (reason !== undefined) return deny(reason);
  }
  return ALLOW;
}

/** The reviewer's read-only tools, plus the two a scratch-dir redirect needs. */
const COORDINATOR_WRITE_TOOLS = new Set(['echo', 'printf']);

function coordinatorExecuteVerdict(command: string, ctx: PolicyContext): PolicyVerdict {
  for (const atom of cmd.parseCommandIntoAtoms(command)) {
    const redirect = coordinatorRedirectVerdict(atom.tokens, ctx);
    if (redirect.action !== 'allow') return redirect;
    const reads = coordinatorScopedReads(atom.tokens, ctx);
    if (reads.action !== 'allow') return reads;
    const args = cmd.gitArgs(atom.tokens);
    if (args !== undefined && REVIEWER_READ_ONLY_GIT_SUBCOMMANDS.has(args[0] ?? '')) continue;
    if (isReviewerSafeTool(atom.tokens)) continue;
    if (COORDINATOR_WRITE_TOOLS.has(atom.tokens[0] ?? '')) continue;
    return deny(
      'coordinator role denies exec except read-only tools and writes into its session dir',
    );
  }
  return ALLOW;
}

/** P20 (T280): reads as visibility allows, writes only inside the session dir, no network. */
function coordinatorVerdict(classified: PermissionRequest, ctx: PolicyContext): PolicyVerdict {
  switch (classified.toolClass) {
    case 'read': {
      if (!hasReadScope(ctx)) return ALLOW;
      for (const path of allTargetPaths(classified)) {
        const reason = readDenyReason(path, ctx);
        if (reason !== undefined) return deny(reason);
      }
      return ALLOW;
    }
    case 'edit': {
      const paths = allTargetPaths(classified);
      if (paths.length === 0) {
        return deny('cannot verify the edit target is inside the coordinator session dir');
      }
      const outside = paths.find((p) => !isPathInside(p, ctx.worktreePath));
      return outside === undefined
        ? ALLOW
        : deny(`coordinator role writes only inside its session dir (${outside} is outside)`);
    }
    case 'execute':
      if (classified.command === undefined) {
        return deny('coordinator role denies exec with no command to classify');
      }
      return coordinatorExecuteVerdict(classified.command, ctx);
    case 'fetch':
      return deny('coordinator role has no network access');
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
    case 'coordinator':
      return coordinatorVerdict(classified, ctx);
  }
}
