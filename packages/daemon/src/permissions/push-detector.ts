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
 *  - T525: a subcommand that isn't a git builtin is read through the alias
 *    the worktree's config gives it (`alias.p = push`), as git would; a
 *    `!` (shell) alias, or one that can't be looked up, fails closed;
 *  - merging into a protected branch is the same act as pushing to it.
 *
 * Both entry points return the deny reason, or `undefined` when allowed.
 */

import { withoutDaemonSecrets } from '../secret-env';
import {
  type CommandAtom,
  hasUnsafeShellConstruct,
  parseCommandIntoAtoms,
  parseGitInvocation,
  pushRefspecs,
  refspecDestBranch,
  tokenizeSegment,
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
  /**
   * T525: `alias.<name>` as the worktree's git reads it (`worktreeGitAliases`).
   * Called only for a subcommand that isn't a git builtin; absent, every
   * such subcommand fails closed.
   */
  alias?: GitAliasLookup;
}

/** T525: one `alias.<name>` lookup: its value, unset, or a lookup that failed. */
export type GitAliasValue = { expansion: string } | 'unset' | 'failed';

export type GitAliasLookup = (name: string) => GitAliasValue;

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

/**
 * `-c alias.p=push` redefines a subcommand token, so it cannot be checked;
 * nor can `-c include.path=<file>` (T525), which can hold one.
 */
function definesAlias(configs: readonly string[]): boolean {
  return configs.some((config) => /^(alias|include|includeif)\./i.test(config));
}

/**
 * T525: git's builtin subcommands (`git --list-cmds=builtins`, git 2.43).
 * Git never runs an alias named like one, so none is looked up: an
 * ordinary call spawns nothing.
 */
const GIT_BUILTIN_SUBCOMMANDS = new Set([
  'add',
  'am',
  'annotate',
  'apply',
  'archive',
  'bisect',
  'blame',
  'branch',
  'bugreport',
  'bundle',
  'cat-file',
  'check-attr',
  'check-ignore',
  'check-mailmap',
  'check-ref-format',
  'checkout',
  'checkout--worker',
  'checkout-index',
  'cherry',
  'cherry-pick',
  'clean',
  'clone',
  'column',
  'commit',
  'commit-graph',
  'commit-tree',
  'config',
  'count-objects',
  'credential',
  'credential-cache',
  'credential-cache--daemon',
  'credential-store',
  'describe',
  'diagnose',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'difftool',
  'fast-export',
  'fast-import',
  'fetch',
  'fetch-pack',
  'fmt-merge-msg',
  'for-each-ref',
  'for-each-repo',
  'format-patch',
  'fsck',
  'fsck-objects',
  'fsmonitor--daemon',
  'gc',
  'get-tar-commit-id',
  'grep',
  'hash-object',
  'help',
  'hook',
  'index-pack',
  'init',
  'init-db',
  'interpret-trailers',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'mailinfo',
  'mailsplit',
  'maintenance',
  'merge',
  'merge-base',
  'merge-file',
  'merge-index',
  'merge-ours',
  'merge-recursive',
  'merge-recursive-ours',
  'merge-recursive-theirs',
  'merge-subtree',
  'merge-tree',
  'mktag',
  'mktree',
  'multi-pack-index',
  'mv',
  'name-rev',
  'notes',
  'pack-objects',
  'pack-redundant',
  'pack-refs',
  'patch-id',
  'pickaxe',
  'prune',
  'prune-packed',
  'pull',
  'push',
  'range-diff',
  'read-tree',
  'rebase',
  'receive-pack',
  'reflog',
  'remote',
  'remote-ext',
  'remote-fd',
  'repack',
  'replace',
  'rerere',
  'reset',
  'restore',
  'rev-list',
  'rev-parse',
  'revert',
  'rm',
  'send-pack',
  'shortlog',
  'show',
  'show-branch',
  'show-index',
  'show-ref',
  'sparse-checkout',
  'stage',
  'stash',
  'status',
  'stripspace',
  'submodule--helper',
  'switch',
  'symbolic-ref',
  'tag',
  'unpack-file',
  'unpack-objects',
  'update-index',
  'update-ref',
  'update-server-info',
  'upload-archive',
  'upload-archive--writer',
  'upload-pack',
  'var',
  'verify-commit',
  'verify-pack',
  'verify-tag',
  'version',
  'whatchanged',
  'worktree',
  'write-tree',
]);

/** T525: a name `alias.<name>` can hold: a config variable name (a letter, then letters, digits, `-`). */
const ALIAS_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * T525: env that moves where git reads its config or finds its commands, so
 * the worktree's aliases may not be the ones it runs (`HOME=. git p` with a
 * `./.gitconfig` the agent wrote).
 */
const ALIAS_RELOCATING_ENV =
  /^(HOME|XDG_CONFIG_HOME|PATH|GIT_CONFIG[A-Z0-9_]*|GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_EXEC_PATH)=/;

/** T525: the global options that do the same (`--git-dir=…`, `--exec-path=…`). */
const ALIAS_RELOCATING_GLOBAL = /^--(git-dir|work-tree|exec-path)(=|$)/;

/** T525: git refuses an alias loop; a chain longer than this is treated as one. */
const ALIAS_DEPTH_MAX = 10;

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

/** One atom's git subcommand (after any alias) and config overrides. */
type GitAtom = { args: string[]; configs: string[] };

/** Why a git atom can't be read: the fail-closed reason's detail (`''`: none to add). */
type Unreadable = { unreadable: string };

/** T525: the alias value as it appears in a reason: one line, capped. */
function shownExpansion(expansion: string): string {
  const line = expansion.replace(/\s+/g, ' ');
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/**
 * T525: `args` (from the subcommand on) with its subcommand's configured
 * alias expanded, and the alias that one names, as git does: a builtin is
 * never an alias; an alias's words go before the call's remaining arguments
 * and may start with global options. A `!` alias is a shell command;
 * `relocated` means the lookup may read the wrong config. Both fail closed.
 */
function expandAliases(
  git: GitAtom,
  relocated: boolean,
  alias: GitAliasLookup | undefined,
): GitAtom | Unreadable {
  let { args, configs } = git;
  for (let depth = 0; ; depth++) {
    const sub = args[0] ?? '';
    if (GIT_BUILTIN_SUBCOMMANDS.has(sub) || FAIL_CLOSED_SUBCOMMANDS.has(sub)) {
      return { args, configs };
    }
    if (GIT_BUILTIN_SUBCOMMANDS.has(sub.toLowerCase())) {
      return {
        unreadable: `\`git ${sub}\` runs \`git ${sub.toLowerCase()}\` on a case-insensitive filesystem`,
      };
    }
    if (!ALIAS_NAME.test(sub)) {
      // Not a name an alias can have, except `a.b`: git matches `alias.a.b` (a
      // subsection) ignoring case, and `git config --get` doesn't.
      return sub.includes('.')
        ? { unreadable: `\`git ${sub}\` may name an alias that can't be looked up` }
        : { args, configs };
    }
    if (relocated) {
      return {
        unreadable: `\`git ${sub}\` may name an alias, and this command moves where git reads its config or finds its commands`,
      };
    }
    if (depth >= ALIAS_DEPTH_MAX) {
      return { unreadable: `git alias \`${sub}\` expands through too many aliases` };
    }
    const value = alias?.(sub) ?? 'failed';
    if (value === 'unset') return { args, configs };
    if (value === 'failed') return { unreadable: `git alias \`${sub}\` could not be looked up` };
    const { expansion } = value;
    if (expansion.startsWith('!')) {
      return {
        unreadable: `git alias \`${sub}\` runs a shell command (\`${shownExpansion(expansion)}\`): run what it stands for directly`,
      };
    }
    // git splits the value on whitespace and quotes, with `\\` escapes this tokenizer doesn't model.
    if (expansion.includes('\\') || hasUnsafeShellConstruct(expansion)) {
      return {
        unreadable: `git alias \`${sub}\` (\`${shownExpansion(expansion)}\`) can't be parsed`,
      };
    }
    const rest = args.slice(1);
    const expanded = parseGitInvocation(['git', ...tokenizeSegment(expansion), ...rest]);
    // An alias with no subcommand of its own (empty, or only options) is git's
    // error: the call's next argument must not be read as the subcommand.
    if (expanded.args === undefined || expanded.args.length <= rest.length) {
      return {
        unreadable: `git alias \`${sub}\` (\`${shownExpansion(expansion)}\`) names no subcommand`,
      };
    }
    args = expanded.args;
    configs = [...configs, ...expanded.configs];
  }
}

/**
 * T525: an assignment or global option that makes the worktree's aliases the
 * wrong ones to read. `-C <dir>` is not one: inside the worktree it is the
 * same repo, and a dir outside it is `no_worktree_escape`'s to refuse.
 */
function relocatesAliases(atom: CommandAtom, args: readonly string[]): boolean {
  if ((atom.prefix ?? []).some((t) => ALIAS_RELOCATING_ENV.test(t))) return true;
  const globals = atom.tokens.slice(1, atom.tokens.length - args.length);
  return globals.some((t) => ALIAS_RELOCATING_GLOBAL.test(t));
}

/** T525: a bare `HOME=.` (no command): it moves the config of every later command in the chain. */
function isRelocatingAssignment(atom: CommandAtom): boolean {
  return atom.tokens.length === 0 && (atom.prefix ?? []).some((t) => ALIAS_RELOCATING_ENV.test(t));
}

/**
 * T525: the argv (from the subcommand on) a git atom runs once a configured
 * alias is expanded, for the checks keyed on the subcommand outside this
 * module (the never-without-human list's force-push, branch-delete and
 * reset-hard). `undefined` when the atom isn't git with a subcommand.
 * Spawns nothing for a builtin.
 */
export function gitArgsThroughAliases(
  atom: CommandAtom,
  alias: GitAliasLookup | undefined,
): { args: string[] } | Unreadable | undefined {
  const { args, configs } = parseGitInvocation(atom.tokens);
  if (args === undefined) return undefined;
  const expanded = expandAliases({ args, configs }, relocatesAliases(atom, args), alias);
  return 'unreadable' in expanded ? expanded : { args: expanded.args };
}

function gitAtomOf(
  atom: CommandAtom,
  alias: GitAliasLookup | undefined,
  relocated: boolean,
): GitAtom | undefined | Unreadable {
  const head = atom.tokens[0];
  if (head === undefined) return undefined;
  if (isUnresolvedToken(head)) return { unreadable: '' };
  if (head !== 'git') return undefined;
  if (atom.tokens.some(isUnresolvedToken)) return { unreadable: '' };
  const { args, configs } = parseGitInvocation(atom.tokens);
  // Global options but no subcommand (`git -C /repo`) can't be cleared.
  if (args === undefined) return { unreadable: '' };
  // An alias the command line defines is unreadable whatever the worktree's config says.
  if (definesAlias(configs)) return { args, configs };
  return expandAliases({ args, configs }, relocated || relocatesAliases(atom, args), alias);
}

/** The fail-closed reason for one unreadable atom. */
function cannotDetermine(command: string, why: Unreadable): string {
  const detail = why.unreadable === '' ? '' : `: ${why.unreadable}`;
  return `${CANNOT_DETERMINE_REASON} in "${command}"${detail}`;
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
  /** T525: an earlier bare `HOME=…` moved the config every later git reads. */
  let relocated = false;

  for (const atom of parseCommandIntoAtoms(command)) {
    relocated ||= isRelocatingAssignment(atom);
    const git = gitAtomOf(atom, ctx.alias, relocated);
    if (git === undefined) continue;
    if ('unreadable' in git) return cannotDetermine(command, git);
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

/** `no_push` (D7: retired by default): any `git push` at all, through an alias too (T525). */
export function detectPush(command: string, alias?: GitAliasLookup): string | undefined {
  if (hasUnsafeShellConstruct(command)) return `${CANNOT_DETERMINE_REASON} in "${command}"`;
  let relocated = false;
  for (const atom of parseCommandIntoAtoms(command)) {
    relocated ||= isRelocatingAssignment(atom);
    const git = gitAtomOf(atom, alias, relocated);
    if (git === undefined) continue;
    if ('unreadable' in git) return cannotDetermine(command, git);
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

/**
 * T525: `alias.<name>` as a session's git reads it in `cwd`: every config
 * file (system, global, the repo's, the worktree's, their includes), with
 * the env sessions run under (`runner/session.ts`: the daemon's own, less its
 * secrets). Never the sandboxed subprocess env: its `HOME` hides the
 * operator's `~/.gitconfig`, where aliases usually live. Argv, never a shell
 * string (D11); `-z`, so a value is read exactly.
 */
export function readGitAlias(
  cwd: string,
  name: string,
  env: Record<string, string> = withoutDaemonSecrets(),
): GitAliasValue {
  try {
    const result = Bun.spawnSync(['git', 'config', '-z', '--get', `alias.${name}`], {
      cwd,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    // 1: the key is unset (only valid names reach here, so never "invalid key").
    if (result.exitCode === 1) return 'unset';
    if (result.exitCode !== 0) return 'failed';
    return { expansion: result.stdout.toString().replace(/\0$/, '') };
  } catch {
    return 'failed';
  }
}

/**
 * T525: the alias lookup for one worktree, lazy and memoized by name (alias
 * names ignore case): one `git config` per alias name, none for a builtin.
 * `read` is the test seam.
 */
export function worktreeGitAliases(
  worktreePath: string,
  read: (cwd: string, name: string) => GitAliasValue = readGitAlias,
): GitAliasLookup {
  const seen = new Map<string, GitAliasValue>();
  return (name) => {
    const key = name.toLowerCase();
    let value = seen.get(key);
    if (value === undefined) {
      value = read(worktreePath, name);
      seen.set(key, value);
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
