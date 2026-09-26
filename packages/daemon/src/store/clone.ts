/**
 * T362: Settings' "clone by URL" (`POST /api/repos/clone`): `git clone`
 * into a folder, then register it through `state.repo_add`, the same path
 * as `POST /api/repos` and `agile repo add`.
 *
 * The daemon holds no credential: git runs with the operator's own HOME,
 * credential helpers and ssh agent (`networkGitEnv`, the allow-listed env
 * `gitNetwork` uses), never with a terminal to prompt on: stdin closed,
 * `GIT_TERMINAL_PROMPT=0`, ssh in `BatchMode` unless the operator set their
 * own ssh command. A clone that outlives the timeout is stopped and its
 * half-made folder removed. Nothing shown to the human carries userinfo.
 */

import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  REPO_NAME_RULE,
  RepoCloneInputSchema,
  RepoNameSchema,
  type ReposConfig,
  formatZodError,
} from '@agile-agents/shared';
import { networkGitEnv } from '../delivery/git';
import { DirListError, expandHome, resolveAbsolutePath } from './browse-dirs';
import { parseRemoteUrl, redactUserinfo } from './remote-url';
import { buildStateRpcMethods } from './rpc-methods';
import type { StateStore } from './store';

export const CLONE_TIMEOUT_MS = 10 * 60_000;
/** After the timeout's SIGTERM (git removes its own half-made folder), SIGKILL this much later. */
const CLONE_KILL_GRACE_MS = 5000;
/** How much of git's stderr a refusal quotes. */
const STDERR_TAIL_LINES = 6;
const STDERR_TAIL_CHARS = 1200;
/** How much of git's stderr file is read at all (its end). */
const STDERR_READ_BYTES = 64 * 1024;

/** A clone refused: 409 when the destination or the name is taken, else 400. */
export class CloneError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = 'CloneError';
  }
}

/** GitHub's `owner/repo` shorthand (owner: letters, digits, inner hyphens). */
const GITHUB_SHORTHAND = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

export interface CloneSource {
  /** What git is given. */
  url: string;
  /** What the human is shown: no userinfo. */
  display: string;
  /** The repo's name from the URL: the folder name and the default registry name. */
  name: string;
}

/** A folder name from a URL's last segment; never a path. */
function folderName(raw: string | undefined): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a folder name with control characters is refused
  if (raw === undefined || /[/\\\u0000-\u001f\u007f]/.test(raw)) return undefined;
  const name = raw.trim();
  return name.length > 0 && name !== '.' && name !== '..' && !name.startsWith('-')
    ? name
    : undefined;
}

/**
 * What to clone: `owner/repo` is GitHub over https; a `~` path is
 * expanded; any other form must be one `parseRemoteUrl` takes (no remote
 * helper, no relative path: the daemon's cwd means nothing to the human).
 */
export function resolveCloneSource(input: string, home: string = homedir()): CloneSource {
  const text = input.trim();
  const shorthand = GITHUB_SHORTHAND.exec(text);
  if (shorthand?.[1] && shorthand[2] && !shorthand[2].startsWith('.')) {
    const repo = shorthand[2].replace(/\.git$/, '');
    const url = `https://github.com/${shorthand[1]}/${repo}.git`;
    const name = folderName(repo);
    if (name) return { url, display: url, name };
  }
  // `github.com/o/r` pasted without its scheme: the public hosts only.
  const url = /^(github\.com|gitlab\.com|bitbucket\.org)\//i.test(text)
    ? `https://${text}`
    : text.startsWith('~')
      ? expandHome(text, home)
      : text;
  if (url.startsWith('-')) throw new CloneError(`not a git URL: ${redactUserinfo(text)}`);
  const parsed = parseRemoteUrl(url);
  if (parsed === undefined) {
    throw new CloneError(
      `not a git URL: ${redactUserinfo(text)} (use https://…, git@host:owner/repo, ssh://…, owner/repo or an absolute path)`,
    );
  }
  if (parsed.protocol === 'file' && !url.startsWith('/') && !url.startsWith('file://')) {
    throw new CloneError(`a local repo must be an absolute path (got ${text})`);
  }
  const name = folderName(parsed.segments.at(-1));
  if (name === undefined) {
    throw new CloneError(`cannot tell the repo's name from ${parsed.url}; give a destination`);
  }
  return { url, display: parsed.url, name };
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where a clone goes when no `dest` is given: next to the most recently
 * registered repo, else `~/Projects`, else the home folder.
 */
export function defaultCloneParent(repos: ReposConfig, home: string = homedir()): string {
  const last = Object.values(repos).at(-1);
  if (last !== undefined && isFolder(dirname(last.path))) return dirname(last.path);
  const projects = join(home, 'Projects');
  return isFolder(projects) ? projects : home;
}

/** The last lines of git's stderr, userinfo scrubbed, plus the fix for the failures that have one. */
export function describeCloneFailure(stderr: string, display: string): string {
  const lines = redactUserinfo(stderr)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let tail = lines.slice(-STDERR_TAIL_LINES).join('\n');
  if (tail.length > STDERR_TAIL_CHARS) tail = `…${tail.slice(-STDERR_TAIL_CHARS)}`;
  let hint = '';
  if (/Host key verification failed/i.test(stderr)) {
    hint =
      ' — the host is not in ~/.ssh/known_hosts yet: connect once from a terminal (e.g. `ssh -T git@github.com`) to trust it, then retry';
  } else if (/Permission denied \(publickey/i.test(stderr)) {
    hint =
      ' — ssh has no key this host accepts: check `ssh -T` from a terminal, or use the https URL';
  } else if (
    /could not read (Username|Password)|terminal prompts disabled|Authentication failed/i.test(
      stderr,
    )
  ) {
    hint =
      ' — git has no working credentials for this host: run `gh auth setup-git` or configure a git credential helper, then retry';
  }
  return `git clone of ${display} failed${hint}${tail ? `:\n${tail}` : ''}`;
}

export interface CloneOptions {
  home?: string;
  timeoutMs?: number;
  /** The env git's allow-list is taken from; default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface CloneResult {
  /** The registry name. */
  name: string;
  /** The clone's real path, as registered. */
  path: string;
}

function gitConfigValue(key: string, cwd: string, env: Record<string, string>): string | undefined {
  try {
    const r = Bun.spawnSync(['git', 'config', '--get', key], {
      cwd,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const value = new TextDecoder().decode(r.stdout).trim();
    return r.exitCode === 0 && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** git's env: the network allow-list, and ssh that fails rather than asks (unless the operator chose an ssh command). */
export function cloneEnv(base: NodeJS.ProcessEnv, cwd: string): Record<string, string> {
  const env = networkGitEnv(base);
  const ownSsh =
    env.GIT_SSH_COMMAND !== undefined ||
    env.GIT_SSH !== undefined ||
    gitConfigValue('core.sshCommand', cwd, env) !== undefined;
  if (!ownSsh) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return env;
}

/** Signals git's process group (T397), else git alone; a group already gone is fine. */
function killGroup(
  proc: { pid: number; kill(signal?: NodeJS.Signals): void },
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // already exited
    }
  }
}

async function runClone(
  source: CloneSource,
  dest: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  // stderr goes to a file, not a pipe: an ssh that outlives git holds git's
  // stderr open, and a pipe would keep this call waiting on it.
  const scratch = mkdtempSync(join(tmpdir(), 'agile-clone-'));
  const stderrPath = join(scratch, 'stderr');
  let timedOut = false;
  let term: ReturnType<typeof setTimeout> | undefined;
  let kill: ReturnType<typeof setTimeout> | undefined;
  try {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(['git', 'clone', '--', source.url, dest], {
        cwd: dirname(dest),
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: Bun.file(stderrPath),
        // T397: its own process group, so a timeout stops git and its ssh together.
        detached: true,
      });
    } catch (err) {
      throw new CloneError(
        `could not run git: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // SIGTERM lets git remove its half-made clone; a git that ignores it is killed.
    // The whole group: an ssh child left running would hold the connection open.
    term = setTimeout(() => {
      timedOut = true;
      killGroup(proc, 'SIGTERM');
      kill = setTimeout(() => killGroup(proc, 'SIGKILL'), CLONE_KILL_GRACE_MS);
    }, timeoutMs);
    const code = await proc.exited;
    let stderr = '';
    try {
      stderr = await Bun.file(stderrPath).slice(-STDERR_READ_BYTES).text();
    } catch {
      // no stderr file: nothing to quote
    }
    return { code, stderr, timedOut };
  } finally {
    clearTimeout(term);
    clearTimeout(kill);
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Clones `input.url` and registers the result. Refused before git runs:
 * a bad body, a URL git would not take plainly, a name already registered,
 * a destination that exists and is not an empty folder, or whose parent
 * folder does not exist.
 */
export async function cloneRepo(
  store: StateStore,
  body: unknown,
  options: CloneOptions = {},
): Promise<CloneResult> {
  const parsed = RepoCloneInputSchema.safeParse(body);
  if (!parsed.success) throw new CloneError(formatZodError('clone request', parsed.error));
  const input = parsed.data;
  const home = options.home ?? homedir();
  const source = resolveCloneSource(input.url, home);
  const repos = store.getRepos();
  const name = input.name ?? source.name;
  // T389: checked before git runs, so a name the registry would refuse leaves no folder behind.
  if (!RepoNameSchema.safeParse(name).success) {
    throw new CloneError(`"${name}" can't be a repo's name: ${REPO_NAME_RULE}; give it a name`);
  }
  if (Object.hasOwn(repos, name)) {
    throw new CloneError(`a repo named ${name} is already registered (${repos[name]?.path})`, 409);
  }

  let dest: string;
  try {
    dest =
      input.dest !== undefined
        ? resolveAbsolutePath(input.dest, home)
        : join(defaultCloneParent(repos, home), source.name);
  } catch (err) {
    throw new CloneError(err instanceof DirListError ? err.message : String(err));
  }
  const existed = existsSync(dest);
  if (existed) {
    if (!isFolder(dest)) throw new CloneError(`${dest} already exists and is not a folder`, 409);
    if (readdirSync(dest).length > 0) {
      throw new CloneError(`${dest} already exists and is not empty`, 409);
    }
  }
  if (!isFolder(dirname(dest))) throw new CloneError(`the folder ${dirname(dest)} does not exist`);

  const timeoutMs = options.timeoutMs ?? CLONE_TIMEOUT_MS;
  const result = await runClone(
    source,
    dest,
    cloneEnv(options.env ?? process.env, dirname(dest)),
    timeoutMs,
  );
  // A clone that finished as the timer fired is a clone, not a timeout.
  if (result.timedOut && result.code !== 0) {
    // git removes its own half-made clone on SIGTERM; after a SIGKILL it can't.
    // The folder was absent or empty before git ran, so all of it is git's.
    if (!existed) rmSync(dest, { recursive: true, force: true });
    else if (isFolder(dest)) {
      for (const child of readdirSync(dest)) {
        rmSync(join(dest, child), { recursive: true, force: true });
      }
    }
    throw new CloneError(
      `git clone of ${source.display} was stopped after ${Math.round(timeoutMs / 1000)}s`,
    );
  }
  if (result.code !== 0) throw new CloneError(describeCloneFailure(result.stderr, source.display));

  // A second clone under the same name may have finished first: never replace it.
  if (Object.hasOwn(store.getRepos(), name)) {
    throw new CloneError(
      `cloned into ${dest}, but a repo named ${name} was registered meanwhile; add it under another name`,
      409,
    );
  }
  try {
    await buildStateRpcMethods(store)['state.repo_add']?.({ name, path: dest });
  } catch (err) {
    throw new CloneError(
      `cloned into ${dest} but could not register it: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { name, path: realpathSync(dest) };
}
