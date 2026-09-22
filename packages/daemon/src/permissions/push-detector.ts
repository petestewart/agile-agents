/**
 * The push detector of design/cockpit-design.md §5.4 — the deterministic
 * check behind the `no_push_protected` and `no_push` built-in pattern rules
 * (D7, D8), borrowed from KiroCrew's argv floor (D11).
 *
 * It exists because the previous implementation was dodged by spelling:
 * T010's QA round found `git -C <repo> push origin main` walked straight
 * past a table that keyed off `args[0]`. So this one is deliberately
 * paranoid, and every property the design lists is a row in
 * `push-detector.test.ts`:
 *
 *  - anchored on the **git subcommand**, read after `-c`/`-C`/global
 *    options, never on a substring of the command line — `git stash push`
 *    and `git log --grep push` are ordinary work;
 *  - shell chains, `sh -c "…"` and pipe glue are tokenised
 *    (`parseCommandIntoAtoms`), not scanned;
 *  - anything the tokenizer cannot resolve — `$(…)`, backticks, `eval`,
 *    `${VAR}` in the git invocation itself, unbalanced quotes — **fails
 *    closed** with `CANNOT_DETERMINE_REASON`;
 *  - a push to an explicitly named non-protected branch is allowed (D7);
 *  - a bare `git push` is resolved against the checked-out branch's
 *    upstream and denied when that is unresolvable;
 *  - merging into a protected branch (`git checkout main && git merge …`,
 *    or a bare `git merge` while HEAD already is one) is the same act as
 *    pushing to it and is denied by the same detector.
 *
 * Both entry points return the deny **reason**, or `undefined` when the
 * command is allowed — the same shape `policy-tables.ts` uses, so the rule
 * checkers in `rule-checks.ts` stay one line each.
 */

import {
  type CommandAtom,
  hasUnsafeShellConstruct,
  parseCommandIntoAtoms,
  parseGitInvocation,
  pushRefspecs,
  refspecDestBranch,
} from './command';

/** The fail-closed reason. Asserted on by the table test, so it is a constant, not prose. */
export const CANNOT_DETERMINE_REASON = 'cannot determine the git subcommand';

export interface PushDetectorContext {
  /** The repo's `protected_branches` (`repos.yaml`, D8 — defaults to `main`/`master`), resolved at check time. */
  protectedBranches: readonly string[];
  /**
   * `git rev-parse --abbrev-ref @{upstream}` in the session's worktree
   * (argv, no shell), or `undefined` when there is no upstream / git
   * failed. Only called for a push with no explicit refspec, so an
   * ordinary `git push origin <branch>` costs no subprocess.
   */
  upstream: () => string | undefined;
  /**
   * The checked-out branch (`git rev-parse --abbrev-ref HEAD`), or
   * `undefined` when unreadable. Only called for a `git merge` with no
   * preceding `checkout`/`switch` in the same command.
   */
  head: () => string | undefined;
}

/** `$` and backticks defeat the tokenizer; `${VAR}` is not caught by `hasUnsafeShellConstruct`. */
function isUnresolvedToken(token: string): boolean {
  return token.includes('$') || token.includes('`');
}

/**
 * Normalised destination names for one refspec: the dest side with a
 * leading `+` and a `refs/heads/` prefix removed, plus its final path
 * segment, so `refs/heads/main` and `refs/remotes/origin/master` are both
 * recognised. Comparing the final segment as well is deliberately
 * over-eager (`origin/main` and a hypothetical `feature/main` both match) —
 * this detector's failure direction is deny, not allow.
 */
function destBranchNames(refspec: string): string[] {
  const dest = refspecDestBranch(refspec).replace(/^refs\/heads\//, '');
  const last = dest.split('/').at(-1);
  return last !== undefined && last !== dest ? [dest, last] : [dest];
}

/** The branch names an upstream ref (`origin/main`, `main`) could mean. */
function upstreamBranchNames(upstream: string): string[] {
  const segments = upstream.split('/');
  return segments.length > 1 ? [upstream, segments.slice(1).join('/')] : [upstream];
}

function matchesProtected(names: readonly string[], protectedBranches: readonly string[]): boolean {
  return names.some((name) => protectedBranches.includes(name));
}

/** `--all`/`--mirror` name no branch and reach every one of them. */
const BLANKET_PUSH_FLAGS = new Set(['--all', '--mirror']);

/** The branch a `checkout`/`switch` leaves HEAD on, or `undefined` when it names none (`git checkout -- file`). */
function branchAfterCheckout(args: string[]): string | undefined {
  for (const token of args.slice(1)) {
    if (token === '--') return undefined;
    // `-b`/`-B`/`-c`/`-C` take the new branch name as their value, which is
    // exactly the branch HEAD ends up on — so the next positional is the
    // answer either way and the flags need no special value-skipping.
    if (token.startsWith('-')) continue;
    return token;
  }
  return undefined;
}

/** Git atoms of one command, in order, with the fail-closed check applied. */
type GitAtom = { args: string[] };

function gitAtomOf(atom: CommandAtom): GitAtom | undefined | 'unknown' {
  const head = atom.tokens[0];
  if (head === undefined) return undefined;
  if (isUnresolvedToken(head)) return 'unknown';
  if (head !== 'git') return undefined;
  if (atom.tokens.some(isUnresolvedToken)) return 'unknown';
  const args = parseGitInvocation(atom.tokens).args;
  // `git` with global options but no subcommand at all (`git -C /repo`) is
  // not a subcommand this detector can clear.
  return args === undefined ? 'unknown' : { args };
}

/**
 * The `no_push_protected` verdict for one command string: a reason when the
 * command pushes to, or merges into, a protected branch (or cannot be read
 * at all), `undefined` when it is allowed.
 */
export function detectProtectedBranchWrite(
  command: string,
  ctx: PushDetectorContext,
): string | undefined {
  if (hasUnsafeShellConstruct(command)) return `${CANNOT_DETERMINE_REASON} in "${command}"`;

  const protectedBranches = ctx.protectedBranches;
  /** HEAD as this command leaves it, once a `checkout`/`switch` has named a branch. */
  let branch: string | undefined;
  let branchKnown = false;

  for (const atom of parseCommandIntoAtoms(command)) {
    const git = gitAtomOf(atom);
    if (git === undefined) continue;
    if (git === 'unknown') return `${CANNOT_DETERMINE_REASON} in "${command}"`;
    const { args } = git;
    const subcommand = args[0];

    if (subcommand === 'push') {
      const blanket = args.find((a) => BLANKET_PUSH_FLAGS.has(a));
      if (blanket !== undefined) {
        return `git push ${blanket} can reach the protected branches (${protectedBranches.join(', ')})`;
      }
      const refspecs = pushRefspecs(args);
      if (refspecs.length === 0) {
        const upstream = ctx.upstream();
        if (upstream === undefined) {
          return 'a bare `git push` could not be resolved to an upstream branch — push an explicit non-protected branch instead';
        }
        if (matchesProtected(upstreamBranchNames(upstream), protectedBranches)) {
          return `a bare \`git push\` would push to ${upstream}, a protected branch`;
        }
        continue;
      }
      for (const refspec of refspecs) {
        if (matchesProtected(destBranchNames(refspec), protectedBranches)) {
          return `push to ${refspecDestBranch(refspec)} is a write to a protected branch (${protectedBranches.join(', ')})`;
        }
      }
      continue;
    }

    if (subcommand === 'checkout' || subcommand === 'switch') {
      const target = branchAfterCheckout(args);
      if (target !== undefined) {
        branch = target;
        branchKnown = true;
      }
      continue;
    }

    if (subcommand === 'merge') {
      const onto = branchKnown ? branch : ctx.head();
      if (onto === undefined) {
        return 'cannot determine which branch `git merge` would merge into — checkout an explicit non-protected branch first';
      }
      if (protectedBranches.includes(onto)) {
        return `merging into ${onto} is the same act as pushing to it (a protected branch)`;
      }
    }
  }

  return undefined;
}

/**
 * The `no_push` verdict (D7: retired by default, so this normally never
 * runs): any `git push` at all, to any branch. Takes no context — there is
 * no branch to resolve when every push is the offence.
 */
export function detectPush(command: string): string | undefined {
  if (hasUnsafeShellConstruct(command)) return `${CANNOT_DETERMINE_REASON} in "${command}"`;
  for (const atom of parseCommandIntoAtoms(command)) {
    const git = gitAtomOf(atom);
    if (git === undefined) continue;
    if (git === 'unknown') return `${CANNOT_DETERMINE_REASON} in "${command}"`;
    if (git.args[0] === 'push') return 'git push is not allowed in this repo';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Building the detector's context out of a real worktree. Lives here so
// both enforcement tiers (the hook and the ACP responder) resolve the two
// branch lookups the same way, and neither spawns git for a call that
// never asks.
// ---------------------------------------------------------------------------

/**
 * One `git rev-parse --abbrev-ref <rev>` in the worktree — argv, never a
 * shell string (D11's argv floor), so a branch name can never be
 * interpreted. `undefined` for any non-zero exit (no upstream configured, a
 * detached HEAD, not a repo at all), which the detector treats as
 * "unresolvable" and denies.
 */
export function revParseAbbrevRef(cwd: string, rev: string): string | undefined {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', rev], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (result.exitCode !== 0) return undefined;
    const out = result.stdout.toString().trim();
    return out.length > 0 && out !== 'HEAD' ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Calls `resolve` at most once, however many rules ask for the answer. */
function memoized(resolve: () => string | undefined): () => string | undefined {
  let done = false;
  let value: string | undefined;
  return () => {
    if (!done) {
      value = resolve();
      done = true;
    }
    return value;
  };
}

/**
 * The `upstream`/`head` half of a `PushDetectorContext` for one worktree,
 * both lazy *and* memoized: an ordinary `git push origin <branch>`, a file
 * edit, or any non-git command spawns nothing at all.
 */
export function worktreeBranchLookups(
  worktreePath: string,
): Pick<PushDetectorContext, 'upstream' | 'head'> {
  return {
    upstream: memoized(() => revParseAbbrevRef(worktreePath, '@{upstream}')),
    head: memoized(() => revParseAbbrevRef(worktreePath, 'HEAD')),
  };
}
