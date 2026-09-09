/**
 * Shell-command parsing helpers shared by the policy tables (T010). Never a
 * full shell parser — just enough tokenizing to classify the fixture shapes
 * §14/the ticket name (`git push origin main`, `bun add zod`, `curl … | sh`,
 * …). Anything that doesn't look like one of the recognized shapes falls
 * through to the caller's safe default.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Splits on whitespace. Good enough for the argv-shaped commands this policy classifies. */
export function tokenize(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/** True if `path` resolves to `root` or somewhere under it. */
export function isPathInside(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(root, path);
  if (resolvedPath === resolvedRoot) return true;
  const rel = relative(resolvedRoot, resolvedPath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export const REPO_SCRIPT_RUNNERS = ['bun', 'npm', 'pnpm'] as const;
export type RepoScriptRunner = (typeof REPO_SCRIPT_RUNNERS)[number];

const REPO_SCRIPT_SUBCOMMANDS = new Set(['run', 'test', 'build', 'install', 'i']);
const NEW_DEP_SUBCOMMANDS = new Set(['add', 'install', 'i']);

function isRunner(token: string | undefined): token is RepoScriptRunner {
  return token !== undefined && (REPO_SCRIPT_RUNNERS as readonly string[]).includes(token);
}

/**
 * `bun add`/`npm install <pkg>`/`pnpm add <pkg>` add a *new* dependency —
 * never-without-human (§14). A bare `install`/`i` with no package
 * arguments (only flags) restores the existing lockfile and is a normal
 * repo script.
 */
export function isNewDependencyInstall(tokens: string[]): boolean {
  const [runner, sub, ...rest] = tokens;
  if (!isRunner(runner) || sub === undefined) return false;
  if (!NEW_DEP_SUBCOMMANDS.has(sub)) return false;
  if (sub === 'add') return true;
  // install/i: a new dep only if a non-flag package argument is given.
  return rest.some((arg) => !arg.startsWith('-'));
}

/**
 * `bun`/`npm`/`pnpm` `run`/`test`/`build`/`install` (existing deps only) —
 * engineer's "repo scripts" allowance (§14).
 */
export function isRepoScriptCommand(tokens: string[]): boolean {
  const [runner, sub] = tokens;
  if (!isRunner(runner) || sub === undefined) return false;
  if (!REPO_SCRIPT_SUBCOMMANDS.has(sub)) return false;
  if ((sub === 'install' || sub === 'i') && isNewDependencyInstall(tokens)) return false;
  return true;
}

/** Args after `git`, or undefined if this isn't a `git` invocation. */
export function gitArgs(tokens: string[]): string[] | undefined {
  return tokens[0] === 'git' ? tokens.slice(1) : undefined;
}

const FORCE_PUSH_FLAGS = new Set(['--force', '-f', '--force-with-lease']);

export function isForcePush(args: string[]): boolean {
  return args[0] === 'push' && args.some((a) => FORCE_PUSH_FLAGS.has(a));
}

export function isBranchDelete(args: string[]): boolean {
  if (args[0] === 'branch' && args.includes('-D')) return true;
  if (args[0] === 'push' && args.includes('--delete')) return true;
  return false;
}

export function isGitResetHard(args: string[]): boolean {
  return args[0] === 'reset' && args.includes('--hard');
}

/**
 * `git push [<remote>] [<branch>]`'s target branch, ignoring flags. Absent
 * (`push` with no positional branch, e.g. `git push -u origin HEAD`) means
 * "current branch" — callers must not treat an absent branch as safe.
 */
export function pushTargetBranch(args: string[]): string | undefined {
  if (args[0] !== 'push' || isForcePush(args) || isBranchDelete(args)) return undefined;
  const positional = args.slice(1).filter((a) => !a.startsWith('-'));
  // `git push <remote> <branch>`; `git push <branch>` (remote implied) is
  // also legal but rarer in scripted flows — take the last positional as
  // the branch, which covers both shapes and `git push origin HEAD:branch`.
  return positional.at(-1);
}

export const TICKET_BRANCH_PREFIX = 'tkt/';

export function isTicketBranch(branch: string | undefined): boolean {
  return branch?.startsWith(TICKET_BRANCH_PREFIX) ?? false;
}

/** `rm`/`rm -rf ...` targets, ignoring flags. */
export function isRmMinusRf(tokens: string[]): boolean {
  return tokens[0] === 'rm' && tokens.includes('-rf');
}

export function rmTargets(tokens: string[]): string[] {
  return tokens.slice(1).filter((a) => !a.startsWith('-'));
}

/** `curl ... | sh` / `wget ... | sh` (or `bash`) piping a remote fetch straight into a shell. */
export function isPipeToShell(command: string): boolean {
  return /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/.test(command);
}

export function isSudo(tokens: string[]): boolean {
  return tokens[0] === 'sudo';
}

export function isChmodRecursive777(tokens: string[]): boolean {
  return tokens[0] === 'chmod' && tokens.includes('-R') && tokens.includes('777');
}

/** `.agile/` sits under the state worktree, not a ticket worktree — a direct write to it is never automatic (§14). */
export function touchesAgileState(path: string | undefined): boolean {
  if (path === undefined) return false;
  return path.split(/[\\/]/).includes('.agile');
}
