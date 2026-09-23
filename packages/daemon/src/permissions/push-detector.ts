/**
 * The push detector (§5.4): the deterministic check behind the
 * `no_push_protected` and `no_push` built-in rules (D7, D8), after
 * KiroCrew's argv floor (D11). Deliberately paranoid, since a table keyed
 * on `args[0]` was once dodged by `git -C <repo> push origin main`; each
 * property is a row in `push-detector.test.ts`:
 *
 *  - anchored on the git subcommand, read past global options, never a
 *    substring (`git stash push` is ordinary work);
 *  - chains, `sh -c "…"` and pipes are tokenised, not scanned;
 *  - anything unresolvable (`$(…)`, backticks, `eval`, `${VAR}`, unbalanced
 *    quotes) fails closed with `CANNOT_DETERMINE_REASON`;
 *  - a push to a named non-protected branch is allowed (D7);
 *  - a bare `git push` is resolved against the upstream (unresolvable ⇒
 *    deny), and a `HEAD`/`@` destination against the checked-out branch;
 *  - `-c alias.…` and the plumbing under `push` (`send-pack`, `http-push`,
 *    `remote-ext`) fail closed;
 *  - merging into a protected branch is the same act as pushing to it.
 *
 * Both entry points return the deny reason, or `undefined` when allowed.
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
  /** The repo's `protected_branches` (D8; default `main`/`master`). */
  protectedBranches: readonly string[];
  /** `@{upstream}` of the worktree, or `undefined`. Called only for a push with no refspec. */
  upstream: () => string | undefined;
  /** The checked-out branch, or `undefined`. Called only when needed. */
  head: () => string | undefined;
}

/** `$` and backticks defeat the tokenizer; `${VAR}` is not caught by `hasUnsafeShellConstruct`. */
function isUnresolvedToken(token: string): boolean {
  return token.includes('$') || token.includes('`');
}

/**
 * Destination names for one refspec: the dest without `+`/`refs/heads/`,
 * plus its final segment. Deliberately over-eager (`feature/main` matches
 * `main`): this detector fails towards deny.
 */
function destBranchNames(refspec: string): string[] {
  const dest = refspecDestBranch(refspec).replace(/^refs\/heads\//, '');
  const last = dest.split('/').at(-1);
  return last !== undefined && last !== dest ? [dest, last] : [dest];
}

/** "The branch I am on": as a destination they name the checked-out branch, not a literal ref. */
const HEAD_ALIASES = new Set(['HEAD', '@']);

/** Commands that reach a push without the `push` subcommand: fail closed. A named list, not an allow-list of git. */
const FAIL_CLOSED_SUBCOMMANDS = new Set(['send-pack', 'http-push', 'remote-ext']);

/** `-c alias.p=push` redefines a subcommand token, so it cannot be checked. */
function definesAlias(configs: readonly string[]): boolean {
  return configs.some((config) => /^alias\./i.test(config));
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
    // `-b`/`-B`/`-c`/`-C` take the new branch, which is the next positional anyway.
    if (token.startsWith('-')) continue;
    return token;
  }
  return undefined;
}

/** One atom's git subcommand and config overrides; `'unknown'` fails closed. */
type GitAtom = { args: string[]; configs: string[] };

function gitAtomOf(atom: CommandAtom): GitAtom | undefined | 'unknown' {
  const head = atom.tokens[0];
  if (head === undefined) return undefined;
  if (isUnresolvedToken(head)) return 'unknown';
  if (head !== 'git') return undefined;
  if (atom.tokens.some(isUnresolvedToken)) return 'unknown';
  const { args, configs } = parseGitInvocation(atom.tokens);
  // Global options but no subcommand (`git -C /repo`) can't be cleared.
  return args === undefined ? 'unknown' : { args, configs };
}

/** `no_push_protected`: a reason when the command pushes to or merges into a protected branch, or can't be read. */
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
    const refused = unreadableGitReason(command, git);
    if (refused !== undefined) return refused;

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
        const dest = refspecDestBranch(refspec);
        if (HEAD_ALIASES.has(dest)) {
          // `git push origin HEAD` writes the checked-out branch's same-named ref.
          const onto = ctx.head();
          if (onto === undefined) {
            return `\`git push ${refspec}\` could not be resolved to a branch (HEAD is unreadable or detached) — push an explicit non-protected branch instead`;
          }
          if (protectedBranches.includes(onto)) {
            return `push of ${dest} would write ${onto}, a protected branch (${protectedBranches.join(', ')})`;
          }
          continue;
        }
        if (matchesProtected(destBranchNames(refspec), protectedBranches)) {
          return `push to ${dest} is a write to a protected branch (${protectedBranches.join(', ')})`;
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

/** `no_push` (D7: retired by default): any `git push` at all. */
export function detectPush(command: string): string | undefined {
  if (hasUnsafeShellConstruct(command)) return `${CANNOT_DETERMINE_REASON} in "${command}"`;
  for (const atom of parseCommandIntoAtoms(command)) {
    const git = gitAtomOf(atom);
    if (git === undefined) continue;
    if (git === 'unknown') return `${CANNOT_DETERMINE_REASON} in "${command}"`;
    const refused = unreadableGitReason(command, git);
    if (refused !== undefined) return refused;
    const subcommand = git.args[0];
    if (subcommand === 'push') return 'git push is not allowed in this repo';
  }
  return undefined;
}

/** Alias overrides and push plumbing can't be checked: the fail-closed reason, else `undefined`. */
function unreadableGitReason(command: string, git: GitAtom): string | undefined {
  if (definesAlias(git.configs)) {
    return `${CANNOT_DETERMINE_REASON} in "${command}": git aliases cannot be checked`;
  }
  const subcommand = git.args[0];
  if (subcommand !== undefined && FAIL_CLOSED_SUBCOMMANDS.has(subcommand)) {
    return `${CANNOT_DETERMINE_REASON} in "${command}": \`git ${subcommand}\` can push without the push subcommand`;
  }
  return undefined;
}

// The context's branch lookups for a real worktree, shared by both
// enforcement tiers; neither spawns git for a call that never asks.

/**
 * `git rev-parse --abbrev-ref <rev>` as argv, never a shell string (D11).
 * `undefined` for any failure (no upstream, detached HEAD, not a repo).
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

/** `upstream`/`head` for one worktree, lazy and memoized: most calls spawn nothing. */
export function worktreeBranchLookups(
  worktreePath: string,
): Pick<PushDetectorContext, 'upstream' | 'head'> {
  return {
    upstream: memoized(() => revParseAbbrevRef(worktreePath, '@{upstream}')),
    head: memoized(() => revParseAbbrevRef(worktreePath, 'HEAD')),
  };
}
