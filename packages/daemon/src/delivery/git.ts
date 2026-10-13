/**
 * Thin git wrapper for the landing path (§8.2). `Bun.spawnSync` with argv,
 * never a shell string, so no argument is re-interpreted. Every spawn uses
 * `sandboxedSubprocessEnv` (git reads `HOME` for global config and
 * credential helpers), and callers pass `repoRoot` explicitly rather than
 * have it guessed from a `/.worktrees/` path segment.
 *
 * `gitNetwork` (T231) is the one exception to the sandbox: push, fetch and
 * ls-remote talk to a remote, so they need the operator's own credential
 * setup (`~/.gitconfig` helpers, `gh auth setup-git`, `insteadOf`, the
 * macOS keychain under the real `$HOME`). They create no commit, so the
 * sandbox's reasons (no writes into the real `$HOME` from test runners, the
 * daemon's own commit identity) don't apply. No token passes through here.
 *
 * `gitWrite` is for anything that can create a commit: unsigned (`-c
 * commit.gpgsign=false` before the verb; the signing hook has failed with
 * "too many open files") and authored by a fixed daemon identity.
 *
 * T536 (D11): no repo hook runs daemon-side. Every call here carries
 * `NO_HOOKS_GIT_CONFIG` before its verb, so do worktree creation
 * (`runner/worktrees.ts`) and a clone (`store/clone.ts`).
 */

import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxedSubprocessEnv } from '../subprocess-env';

const textDecoder = new TextDecoder();

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * T536 (D11): the `-c` pairs every daemon git call carries before its verb.
 * A command-line `-c` beats every config file, so neither `$GIT_DIR/hooks`
 * nor a hooks dir the repo configures (`core.hooksPath=.githooks`, husky)
 * is read. Such a dir is tracked: an agent can commit a hook to it, and a
 * merge, checkout, `worktree add`, ref update or push the daemon runs would
 * run that hook outside every gate and sandbox. `/dev/null` is not a
 * directory, so no hook is ever found under it (T343's read-only env uses
 * the same); an empty dir inside the checkout could be filled by a landed
 * commit. `core.fsmonitor=false`: no fsmonitor program runs either.
 */
export const NO_HOOKS_GIT_CONFIG: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
];

/** Fixed identity for every commit this module makes. */
export const DAEMON_GIT_AUTHOR = {
  name: 'agiled',
  email: 'agiled@agile-agents.local',
} as const;

function daemonEnv(repoRoot: string): Record<string, string> {
  return {
    ...sandboxedSubprocessEnv(repoRoot, 'git'),
    GIT_AUTHOR_NAME: DAEMON_GIT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: DAEMON_GIT_AUTHOR.email,
    GIT_COMMITTER_NAME: DAEMON_GIT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: DAEMON_GIT_AUTHOR.email,
  };
}

/**
 * T534: never throws. Bun's `spawnSync` throws (ENOENT, "posix_spawn 'git'")
 * when `cwd` is gone, as a node's worktree can be; that is git's own exit
 * 128 here, in git's words, before `env` makes any dir. Any other spawn
 * failure is a failed result too.
 */
function spawnGit(argv: string[], cwd: string, env: () => Record<string, string>): GitResult {
  if (!existsSync(cwd)) {
    return {
      exitCode: 128,
      stdout: '',
      stderr: `fatal: cannot change to '${cwd}': No such file or directory`,
    };
  }
  try {
    const result = Bun.spawnSync(argv, {
      cwd,
      env: env(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode,
      stdout: textDecoder.decode(result.stdout).trim(),
      stderr: textDecoder.decode(result.stderr).trim(),
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { exitCode: 128, stdout: '', stderr: `fatal: could not run git in '${cwd}': ${why}` };
  }
}

/** Read-only and plumbing commands (log, diff, rev-parse, worktree, ...). */
export function git(args: string[], cwd: string, repoRoot: string): GitResult {
  return spawnGit(['git', ...NO_HOOKS_GIT_CONFIG, ...args], cwd, () =>
    sandboxedSubprocessEnv(repoRoot, 'git'),
  );
}

/**
 * T231: a command that talks to a remote (push, fetch, ls-remote), run with
 * the operator's real `HOME`/`XDG_CONFIG_HOME` so their credential helper
 * answers. `GIT_TERMINAL_PROMPT=0`: a missing credential fails at once
 * instead of waiting on a terminal the daemon doesn't have.
 */
export function gitNetwork(args: string[], cwd: string): GitResult {
  return spawnGit(['git', ...NO_HOOKS_GIT_CONFIG, ...args], cwd, () => networkGitEnv(process.env));
}

const NETWORK_ENV_NAMES = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TERM',
  'SSH_AUTH_SOCK',
  'GNUPGHOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  // Read by `gh auth git-credential` when the operator set them.
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
]);
const NETWORK_ENV_PREFIXES = ['LC_', 'XDG_', 'SSH_', 'GIT_'];

/**
 * An allow-list, never the daemon's whole env: the classifier key and any
 * other daemon secret must not reach git, credential helpers or hooks.
 */
export function networkGitEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (NETWORK_ENV_NAMES.has(name) || NETWORK_ENV_PREFIXES.some((p) => name.startsWith(p))) {
      out[name] = value;
    }
  }
  // The daemon's commit identity belongs to gitWrite only.
  for (const name of [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ]) {
    delete out[name];
  }
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}

const CREDENTIAL_FAILURE =
  /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Invalid username or password|Permission denied \(publickey|Device not configured/i;

/**
 * One line for a failed network git call. A missing or rejected credential
 * names the fix; anything else is git's first line, with any userinfo in a
 * URL scrubbed.
 */
export function describeGitNetworkFailure(stderr: string, remote: string): string {
  if (CREDENTIAL_FAILURE.test(stderr)) {
    return `git has no working credentials for ${remote}: run \`gh auth setup-git\` or configure a git credential helper, then retry`;
  }
  const first = stderr.split('\n').find((l) => l.trim().length > 0) ?? 'unknown error';
  return first.replace(/(\w+:\/\/)[^/@\s]*@/g, '$1').slice(0, 300);
}

export class GitCommandError extends Error {
  constructor(
    public readonly args: string[],
    public readonly cwd: string,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed in ${cwd}: ${stderr}`);
    this.name = 'GitCommandError';
  }
}

/** Runs a plumbing command, throwing `GitCommandError` on a non-zero exit. */
export function runGit(args: string[], cwd: string, repoRoot: string): string {
  const result = git(args, cwd, repoRoot);
  if (result.exitCode !== 0) {
    throw new GitCommandError(args, cwd, result.stderr);
  }
  return result.stdout;
}

/**
 * Merge and commit: unsigned and daemon-authored. Never throws: a conflict
 * is an outcome the caller inspects, and so is a missing `cwd` (T534).
 */
export function gitWrite(args: string[], cwd: string, repoRoot: string): GitResult {
  return spawnGit(['git', ...NO_HOOKS_GIT_CONFIG, '-c', 'commit.gpgsign=false', ...args], cwd, () =>
    daemonEnv(repoRoot),
  );
}

/**
 * T535: `path` is a checkout of its own: a real directory (not a symlink)
 * with a `.git` file or dir in it. Anything else is not a node's worktree.
 * Git run in a plain directory left under `<repo>/.worktrees/` walks up to
 * the operator's own checkout, so no agent starts there and no daemon git
 * write runs there.
 */
export function isOwnCheckout(path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && existsSync(join(path, '.git'));
  } catch {
    return false;
  }
}

export interface RemoveWorktreeResult {
  removed: boolean;
  /** Why it wasn't removed; present whenever `removed` is `false`. */
  reason?: string;
}

/**
 * Removes a worktree without ever throwing. Any tracked modification keeps
 * it (never force past real work); untracked files only get `--force`,
 * since a plain remove refuses a non-empty dir. A failed status read is
 * reported like a failed removal: the contract is "is it gone now".
 *
 * T534: a directory already gone holds no work and counts as removed.
 * `prune` drops git's record of it, which frees its branch (and of any
 * other worktree whose dir is gone, as every land's cleanup already does).
 */
export function removeWorktreeSafely(repoRoot: string, worktreePath: string): RemoveWorktreeResult {
  if (!existsSync(worktreePath)) {
    git(['worktree', 'prune'], repoRoot, repoRoot);
    return { removed: true };
  }

  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], worktreePath, repoRoot);
  if (status.exitCode !== 0) {
    return { removed: false, reason: `could not read worktree status: ${status.stderr}` };
  }

  const lines = status.stdout.split('\n').filter((line) => line.length > 0);
  const hasTrackedChanges = lines.some((line) => !line.startsWith('??'));
  if (hasTrackedChanges) {
    return {
      removed: false,
      reason: 'worktree has uncommitted tracked changes — kept for inspection, not force-removed',
    };
  }

  const hasUntrackedOnly = lines.length > 0;
  const args = hasUntrackedOnly
    ? ['worktree', 'remove', '--force', worktreePath]
    : ['worktree', 'remove', worktreePath];
  const result = git(args, repoRoot, repoRoot);
  if (result.exitCode !== 0) {
    return { removed: false, reason: `git worktree remove failed: ${result.stderr}` };
  }
  return { removed: true };
}
