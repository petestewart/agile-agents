/**
 * Shell-command parsing helpers for the policy tables. Not a full shell
 * parser: a best-effort classifier. Anything it can't confidently classify
 * (a subshell, a backtick, `eval`, unbalanced quotes) is unclassifiable and
 * routed to `hil`, never `allow` (`hasUnsafeShellConstruct`).
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join as joinPath, relative, resolve, sep } from 'node:path';

// Quote-aware splitting/tokenizing

export type SegmentDelimiter = 'start' | ';' | '&&' | '||' | '|' | '&' | '\n';

export interface RawSegment {
  raw: string;
  delimiterBefore: SegmentDelimiter;
}

/**
 * Splits on `;`, `&&`, `||`, `|`, `&` and newlines, never inside quotes, so
 * `sh -c "git push origin main"` stays one segment (its `-c` argument is
 * recursed into by `parseCommandIntoAtoms`).
 */
export function splitCommandSegments(command: string): RawSegment[] {
  const segments: RawSegment[] = [];
  let current = '';
  let delimiterBefore: SegmentDelimiter = 'start';
  let quote: '"' | "'" | null = null;

  const push = (next: SegmentDelimiter) => {
    const trimmed = current.trim();
    if (trimmed.length > 0) segments.push({ raw: trimmed, delimiterBefore });
    current = '';
    delimiterBefore = next;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? '';
    if (quote) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '\n') {
      push('\n');
      continue;
    }
    if (c === ';') {
      push(';');
      continue;
    }
    if (c === '&' && command[i + 1] === '&') {
      push('&&');
      i++;
      continue;
    }
    if (c === '|' && command[i + 1] === '|') {
      push('||');
      i++;
      continue;
    }
    if (c === '|') {
      // `|&` pipes stderr too: still a pipe.
      push('|');
      if (command[i + 1] === '&') i++;
      continue;
    }
    // A lone `&` runs what came before in the background and starts a new
    // command (`echo & cat /etc/passwd`). Not `>&`, `<&` or `&>`.
    if (c === '&' && !/[<>]/.test(command[i - 1] ?? '') && command[i + 1] !== '>') {
      push('&');
      continue;
    }
    current += c;
  }
  push('start'); // flush the tail; the synthetic delimiter is never read
  return segments;
}

/** Tokenizes one segment on whitespace, respecting (and stripping) quotes — a quoted phrase becomes one token. */
export function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let inToken = false;

  for (const c of segment) {
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        current += c;
      }
      inToken = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += c;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

// Unclassifiable shell constructs: hil, never allow

/**
 * Command substitution, `eval` or unbalanced quotes defeat this tokenizer:
 * there is no sound way to know what will run. Always `hil`, any role.
 */
export function hasUnsafeShellConstruct(command: string): boolean {
  if (command.includes('$(')) return true;
  if (command.includes('`')) return true;
  if (/(^|[\s;&|])eval\b/.test(command)) return true;
  const countUnescaped = (ch: string) => {
    let count = 0;
    for (let i = 0; i < command.length; i++) {
      if (command[i] === ch && command[i - 1] !== '\\') count++;
    }
    return count;
  };
  if (countUnescaped('"') % 2 !== 0) return true;
  if (countUnescaped("'") % 2 !== 0) return true;
  return false;
}

// Wrapper/env-prefix stripping

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
/** Leading wrappers that don't change what is run, for classification. */
const WRAPPER_COMMANDS = new Set(['command', 'exec', 'nohup', 'time', 'env', 'xargs']);

function normalizeToken(token: string): string {
  return token.startsWith('\\') ? token.slice(1) : token;
}

/** Strips leading `VAR=value` assignments and wrapper commands, and unescapes a leading `\git`-style backslash. */
export function stripPrefixes(tokens: string[]): string[] {
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = normalizeToken(tokens[i] ?? '');
    if (ENV_ASSIGNMENT_RE.test(t)) continue;
    if (WRAPPER_COMMANDS.has(t)) continue;
    break;
  }
  return tokens.slice(i).map(normalizeToken);
}

// Segmentation into atoms: split on control operators, recurse into
// `sh -c "..."`, and remember pipe adjacency so `curl ... | sh` survives.

export interface CommandAtom {
  /** Prefix-stripped tokens for this atomic command. */
  tokens: string[];
  /** True if this atom's stdin is the previous atom's stdout (`prev | this`). */
  precededByPipe: boolean;
  /** The immediately preceding atom's tokens, when `precededByPipe`. */
  prevTokens?: string[];
  /** T336: `VAR=value` assignments or a wrapper (`env`, `xargs`, ...) were stripped from its front. */
  prefixed?: true;
  /** T343: the stripped tokens themselves (`VAR=value`, wrappers), when `prefixed`. */
  prefix?: string[];
}

const SHELL_RUNNERS = new Set(['sh', 'bash', 'zsh']);

function isShellDashC(tokens: string[]): boolean {
  return SHELL_RUNNERS.has(tokens[0] ?? '') && tokens[1] === '-c' && tokens.length >= 3;
}

/** Splits `command` into prefix-stripped atoms, recursing into `sh|bash|zsh -c "..."`. */
export function parseCommandIntoAtoms(command: string): CommandAtom[] {
  const atoms: CommandAtom[] = [];
  const rawSegments = splitCommandSegments(command);

  for (const seg of rawSegments) {
    const raw = tokenizeSegment(seg.raw);
    const tokens = stripPrefixes(raw);
    const prefixed =
      tokens.length < raw.length
        ? { prefixed: true as const, prefix: raw.slice(0, raw.length - tokens.length) }
        : {};
    if (isShellDashC(tokens)) {
      const nested = parseCommandIntoAtoms(tokens[2] ?? '');
      for (const [idx, atom] of nested.entries()) {
        if (idx === 0) {
          const prev = atoms.at(-1);
          atoms.push({
            tokens: atom.tokens,
            precededByPipe: seg.delimiterBefore === '|',
            prevTokens: seg.delimiterBefore === '|' ? prev?.tokens : undefined,
            ...(atom.prefixed ? { prefixed: true as const, prefix: atom.prefix ?? [] } : prefixed),
          });
        } else {
          atoms.push(atom.prefixed ? atom : { ...atom, ...prefixed });
        }
      }
      continue;
    }
    const prev = atoms.at(-1);
    atoms.push({
      tokens,
      precededByPipe: seg.delimiterBefore === '|',
      prevTokens: seg.delimiterBefore === '|' ? prev?.tokens : undefined,
      ...prefixed,
    });
  }
  return atoms;
}

/** `curl`/`wget` piped straight into a bare shell (`-c` is handled by recursion). */
const REMOTE_FETCHERS = new Set(['curl', 'wget']);

export function isPipedIntoBareShell(atom: CommandAtom): boolean {
  return (
    atom.precededByPipe &&
    SHELL_RUNNERS.has(atom.tokens[0] ?? '') &&
    atom.prevTokens !== undefined &&
    REMOTE_FETCHERS.has(atom.prevTokens[0] ?? '')
  );
}

// Path containment

/**
 * `realpath`s `p`, walking up to its nearest existing ancestor when `p`
 * doesn't exist yet, so a symlink anywhere on the way (under the worktree
 * or among the root's own ancestors) is followed before the containment
 * check. Never throws: falls back to the plain resolved path.
 */
function realpathNearestExisting(p: string): string {
  const target = resolve(p);
  const missingSegments: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missingSegments.length > 0 ? resolve(real, ...missingSegments.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return target; // even the fs root failed: give up safely
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

/** True if `path` resolves to `root` or under it, both `realpath`'d so a symlink can't launder an escape. */
export function isPathInside(path: string, root: string): boolean {
  const resolvedRoot = realpathNearestExisting(resolve(root));
  const resolvedPath = realpathNearestExisting(resolve(root, path));
  if (resolvedPath === resolvedRoot) return true;
  const rel = relative(resolvedRoot, resolvedPath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// `~`/`$VAR`/backtick resolution for path arguments and redirect targets

export type ResolvedPathArgument = { safe: true; path: string } | { safe: false };

/**
 * Resolves a path token the way the shell would before the containment
 * check: `~` and `~/rest` expand against the real home (so
 * `cat ~/.ssh/id_rsa` is never "inside"). `$`, a backtick or `~user` is
 * unclassifiable (`{ safe: false }`, routed to `hil`).
 */
export function resolveTargetPath(token: string): ResolvedPathArgument {
  if (token.includes('$') || token.includes('`')) return { safe: false };
  if (token === '~') return { safe: true, path: homedir() };
  if (token.startsWith('~/')) return { safe: true, path: joinPath(homedir(), token.slice(2)) };
  if (token.startsWith('~')) return { safe: false }; // `~user`: unsupported
  return { safe: true, path: token };
}

// Repo scripts / dependency installs

export const REPO_SCRIPT_RUNNERS = ['bun', 'npm', 'pnpm'] as const;
export type RepoScriptRunner = (typeof REPO_SCRIPT_RUNNERS)[number];

const REPO_SCRIPT_SUBCOMMANDS = new Set(['run', 'test', 'build', 'install', 'i']);
const NEW_DEP_SUBCOMMANDS = new Set(['add', 'install', 'i']);
/** Other package managers: new-dependency installs are caught, without the lockfile carve-out. */
const OTHER_PACKAGE_MANAGERS = new Set(['yarn', 'pip', 'pip3', 'cargo', 'gem']);
const OTHER_PACKAGE_MANAGER_INSTALL_SUBCOMMANDS = new Set(['add', 'install']);

function isRunner(token: string | undefined): token is RepoScriptRunner {
  return token !== undefined && (REPO_SCRIPT_RUNNERS as readonly string[]).includes(token);
}

/**
 * `bun add`, `npm install <pkg>`, `yarn add`, `pip install <pkg>`, ... add
 * a new dependency: never-without-human. A bare `install`/`i` with only
 * flags restores the lockfile and is a normal repo script.
 */
export function isNewDependencyInstall(tokens: string[]): boolean {
  const [runner, sub, ...rest] = tokens;
  if (runner !== undefined && OTHER_PACKAGE_MANAGERS.has(runner)) {
    return sub !== undefined && OTHER_PACKAGE_MANAGER_INSTALL_SUBCOMMANDS.has(sub);
  }
  if (!isRunner(runner) || sub === undefined) return false;
  if (!NEW_DEP_SUBCOMMANDS.has(sub)) return false;
  if (sub === 'add') return true;
  // install/i: a new dep only if a non-flag package argument is given.
  return rest.some((arg) => !arg.startsWith('-'));
}

/** `bun`/`npm`/`pnpm` `run`/`test`/`build`/`install` (existing deps only): the repo-scripts allowance. */
export function isRepoScriptCommand(tokens: string[]): boolean {
  const [runner, sub] = tokens;
  if (!isRunner(runner) || sub === undefined) return false;
  if (!REPO_SCRIPT_SUBCOMMANDS.has(sub)) return false;
  if ((sub === 'install' || sub === 'i') && isNewDependencyInstall(tokens)) return false;
  return true;
}

const CHECK_SCRIPTS = ['test', 'typecheck', 'lint', 'build'] as const;

/**
 * T339: the repo's own check commands, from the worktree's `package.json`
 * `scripts` (test, typecheck, lint, build), run with the runner its
 * lockfile names (bun, then pnpm, then yarn, else npm). Empty when there is no readable `package.json`.
 */
export function repoScriptChecks(worktreePath: string): string[] {
  let scripts: unknown;
  try {
    scripts = JSON.parse(readFileSync(joinPath(worktreePath, 'package.json'), 'utf8')).scripts;
  } catch {
    return [];
  }
  if (typeof scripts !== 'object' || scripts === null) return [];
  const has = (f: string) => existsSync(joinPath(worktreePath, f));
  const runner =
    has('bun.lock') || has('bun.lockb')
      ? 'bun'
      : has('pnpm-lock.yaml')
        ? 'pnpm'
        : has('yarn.lock')
          ? 'yarn'
          : 'npm';
  return CHECK_SCRIPTS.filter(
    (s) => typeof (scripts as Record<string, unknown>)[s] === 'string',
  ).map((s) => `${runner} run ${s}`);
}

// git: global-option-aware subcommand lookup

/** Global `git` options that take a value (`-C x` or `--git-dir=x`). */
const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
]);
/** Global `git` options that never take a value. */
const GIT_GLOBAL_FLAGS_NO_VALUE = new Set([
  '--no-pager',
  '-p',
  '-P',
  '--paginate',
  '--no-replace-objects',
  '--bare',
  '--literal-pathspecs',
  '--no-optional-locks',
]);

export interface ParsedGitInvocation {
  /** Tokens from the subcommand onward, or `undefined` if not `git` or no subcommand found. */
  args: string[] | undefined;
  /** Every `-C <path>` before the subcommand (git applies them left to right). */
  cPaths: string[];
  /**
   * Every `-c <key>=<value>` before the subcommand: these change what the
   * subcommand means (`-c alias.p=push p` is a push), so the push detector
   * must see them.
   */
  configs: string[];
}

/** Scans past `git`'s global options so `git -C /repo push origin main` is recognized as a `push`. */
export function parseGitInvocation(tokens: string[]): ParsedGitInvocation {
  if (tokens[0] !== 'git') return { args: undefined, cPaths: [], configs: [] };
  const cPaths: string[] = [];
  const configs: string[] = [];
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i] ?? '';
    if (!t.startsWith('-')) {
      return { args: tokens.slice(i), cPaths, configs };
    }
    const eq = t.indexOf('=');
    const flagName = eq !== -1 ? t.slice(0, eq) : t;
    if (flagName === '-C') {
      const value = eq !== -1 ? t.slice(eq + 1) : tokens[i + 1];
      if (value !== undefined) cPaths.push(value);
      i += eq !== -1 ? 1 : 2;
      continue;
    }
    if (flagName === '-c') {
      const value = eq !== -1 ? t.slice(eq + 1) : tokens[i + 1];
      if (value !== undefined) configs.push(value);
      i += eq !== -1 ? 1 : 2;
      continue;
    }
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(flagName)) {
      i += eq !== -1 ? 1 : 2;
      continue;
    }
    if (GIT_GLOBAL_FLAGS_NO_VALUE.has(flagName)) {
      i += 1;
      continue;
    }
    // Unrecognized flag: assume no separate value. Worst case the
    // subcommand is mis-located by one token, which the fallback deny/hil
    // paths still catch (never an unintended allow).
    i += 1;
  }
  return { args: undefined, cPaths, configs };
}

/** T336: the git subcommands a read-only call may run. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set(['diff', 'log', 'show', 'status']);

/**
 * T336: options a read-only git call may not carry anywhere: they set config
 * (`-c`, `--config-env`: an alias or a pager is config), move git's dirs, write
 * a file (`--output`, `-o`), or run a program (`--ext-diff`, `--textconv`, a pager).
 */
const UNSAFE_READ_GIT_OPTIONS = new Set([
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--output',
  '-o',
  '--ext-diff',
  '--textconv',
  '--open-files-in-pager',
  '--paginate',
]);

/**
 * T336: a git call that only reads, by allowlist: nothing stripped from its
 * front (no `GIT_*=` or other assignment, no wrapper), nothing before the
 * subcommand but `-C <dir>` and one `--no-pager` (so no `-p`/`--paginate`, `-c`, `--config-env`, ...),
 * a subcommand in `diff`/`log`/`show`/`status`, and none of the unsafe options.
 */
export function isReadOnlyGitAtom(atom: CommandAtom): boolean {
  if (atom.prefixed === true) return false;
  const tokens = atom.tokens;
  if (tokens[0] !== 'git') return false;
  let i = 1;
  let noPager = false;
  for (;;) {
    if (tokens[i] === '-C') {
      if (tokens[i + 1] === undefined) return false;
      i += 2;
    } else if (tokens[i] === '--no-pager' && !noPager) {
      // T343: one `--no-pager` only turns the pager off.
      noPager = true;
      i += 1;
    } else break;
  }
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(tokens[i] ?? '')) return false;
  return !tokens.slice(i + 1).some((t) => {
    const eq = t.indexOf('=');
    return UNSAFE_READ_GIT_OPTIONS.has(eq === -1 ? t : t.slice(0, eq));
  });
}

/** T343: `git config` options that write (or open an editor on) a config file. */
const GIT_CONFIG_WRITE_OPTIONS = new Set([
  '--add',
  '--unset',
  '--unset-all',
  '--replace-all',
  '--rename-section',
  '--remove-section',
  '-e',
  '--edit',
]);
/** T343: `git config` options that only read. */
const GIT_CONFIG_READ_OPTIONS = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--get-color',
  '--get-colorbool',
  '-l',
  '--list',
]);
/** T343: `git config` options whose value is the next token. */
const GIT_CONFIG_VALUE_OPTIONS = new Set([
  '-f',
  '--file',
  '--blob',
  '--type',
  '--default',
  '--comment',
  '--value',
]);

/**
 * T343: `args` (from `gitArgs`) is a `git config` that sets, unsets, renames
 * or edits: anything but `--get*`/`--list`, the `get`/`list` subcommands or
 * a lone key. Unknown shapes count as writes.
 */
export function isGitConfigWrite(args: string[]): boolean {
  if (args[0] !== 'config') return false;
  const rest = args.slice(1);
  if (rest.some((t) => GIT_CONFIG_WRITE_OPTIONS.has(t))) return true;
  if (rest.some((t) => GIT_CONFIG_READ_OPTIONS.has(t))) return false;
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] ?? '';
    if (GIT_CONFIG_VALUE_OPTIONS.has(t)) i++;
    else if (!t.startsWith('-')) positionals.push(t);
  }
  const [first] = positionals;
  if (first === 'get' || first === 'list') return false;
  return positionals.length !== 1;
}

/** T343: env that points git at another repo, worktree, index or template dir. */
const GIT_REDIRECTING_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_TEMPLATE_DIR',
]);

/**
 * T343: why an engineer's git call must be held, else `undefined`: it points
 * git at other dirs (`--git-dir`, `--work-tree`, `GIT_DIR=`, ...), so its
 * writes can land in the repo's shared `.git`, or it is a `git init` that
 * can copy a template into it (a re-init of a linked worktree copies the
 * template into the common dir, `info/attributes` included).
 */
export function gitDirRedirectReason(atom: CommandAtom): string | undefined {
  const invocation = parseGitInvocation(atom.tokens);
  if (invocation.args === undefined) return undefined;
  const envName = (atom.prefix ?? [])
    .map((t) => t.slice(0, Math.max(0, t.indexOf('='))))
    .find((name) => GIT_REDIRECTING_ENV.has(name));
  if (envName !== undefined) return `git with ${envName}= points git at other dirs`;
  const globals = atom.tokens.slice(1, atom.tokens.length - invocation.args.length);
  if (globals.some((t) => /^--(git-dir|work-tree)(=|$)/.test(t))) {
    return 'git with --git-dir/--work-tree points git at other dirs';
  }
  const args = invocation.args;
  if (
    args[0] === 'init' &&
    (invocation.configs.length > 0 ||
      globals.some((t) => t.startsWith('--config-env')) ||
      args.some((t) => /^--(template|separate-git-dir)(=|$)/.test(t)))
  ) {
    return 'git init with a template, separate git dir or config can write into the shared .git';
  }
  return undefined;
}

/** T343: subcommands whose `-o <path>` is an output file or directory. */
const GIT_DASH_O_OUTPUT = new Set(['archive', 'format-patch', 'diff', 'log', 'show', 'range-diff']);

/**
 * T343: every path a git call (`args` from `gitArgs`) writes a file at:
 * `--output`, `--output-directory`, `-o` on the diff family, `archive` and
 * `format-patch`, `checkout-index --prefix`, `bundle create <file>`, and
 * `init`'s directory. The caller confines them to the worktree, outside `.git`.
 */
export function gitWriteTargets(args: string[]): string[] {
  const sub = args[0] ?? '';
  const targets: string[] = [];
  const valued = (flag: string) =>
    flag === '--output' ||
    flag === '--output-directory' ||
    (flag === '-o' && GIT_DASH_O_OUTPUT.has(sub)) ||
    (flag === '--prefix' && sub === 'checkout-index');
  for (let i = 1; i < args.length; i++) {
    const t = args[i] ?? '';
    const eq = t.indexOf('=');
    const flag = eq === -1 ? t : t.slice(0, eq);
    if (!valued(flag)) continue;
    const value = eq === -1 ? args[i + 1] : t.slice(eq + 1);
    if (value !== undefined) targets.push(value);
    if (eq === -1) i++;
  }
  if (sub === 'bundle' && args[1] === 'create' && args[2] !== undefined) targets.push(args[2]);
  if (sub === 'init') {
    const dir = args.slice(1).find((t) => !t.startsWith('-'));
    targets.push(dir ?? '.');
  }
  return targets;
}

/** T343: subcommands whose positionals are refs or pathspecs to read, not paths to write. */
const GIT_READ_POSITIONAL_SUBCOMMANDS = new Set(['log', 'diff', 'show', 'status', 'blame', 'grep']);

/** T343: a token git may take as a filesystem path: absolute, `~`, `$`, `./`, a `..` segment, or on disk. */
function looksLikeGitPath(value: string, root: string): boolean {
  if (value === '' || value === '.') return false;
  if (/^[/~$]/.test(value) || value.startsWith('./')) return true;
  if (value.split('/').includes('..')) return true;
  return existsSync(resolve(root, value));
}

/**
 * T343: every argument of a git call (`args` from `gitArgs`) that may be a
 * path, whatever the subcommand: option values (`--x=path`, `-xpath`) and
 * positionals, except a read subcommand's positionals. A ref (`origin/main`)
 * is not a path unless it exists on disk. The caller holds any that resolve
 * outside the worktree or into `.git`.
 */
export function gitPathArguments(args: string[], root: string): string[] {
  const readPositionals = GIT_READ_POSITIONAL_SUBCOMMANDS.has(args[0] ?? '');
  const paths: string[] = [];
  let messageNext = false;
  for (const t of args.slice(1)) {
    // A commit/tag message (`-m`, `-am`, `--message`) is text, never a path.
    if (messageNext) {
      messageNext = false;
      continue;
    }
    if (t === '--message' || /^-[A-Za-z]*m$/.test(t)) {
      messageNext = true;
      continue;
    }
    if (t.startsWith('--message=') || t.startsWith('-m')) continue;
    let value: string;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      value = t.slice(eq + 1);
    } else if (t.startsWith('-')) {
      value = t.slice(2);
    } else {
      if (readPositionals) continue;
      value = t;
    }
    if (looksLikeGitPath(value, root)) paths.push(value);
  }
  return paths;
}

/** T343: env that makes git run a program of the caller's choosing. */
const GIT_PROGRAM_ENV =
  /^(GIT_CONFIG_[A-Z0-9_]*|GIT_CONFIG|GIT_EXEC_PATH|GIT_PAGER|PAGER|GIT_EXTERNAL_DIFF|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|GIT_EDITOR|GIT_SEQUENCE_EDITOR|EDITOR|VISUAL)=(.*)$/;
/** Editor values that run nothing: shell builtins (git runs the editor through `sh`). */
const INERT_EDITOR = /^(GIT_EDITOR|GIT_SEQUENCE_EDITOR|EDITOR|VISUAL)=(true|:)$/;

/**
 * T343: an engineer's git call that overrides config, or env git reads as
 * config, with something that can run a program (`-c core.pager=...`,
 * `--config-env`, `--exec-path`, `GIT_PAGER=`, `GIT_SSH_COMMAND=`, ...), so
 * a held command can't ride in on a git key. `GIT_EDITOR=true` (a builtin)
 * is inert and stays allowed.
 */
export function gitProgramOverride(atom: CommandAtom): boolean {
  const invocation = parseGitInvocation(atom.tokens);
  if (invocation.args === undefined) return false;
  if (invocation.configs.length > 0) return true;
  const globals = atom.tokens.slice(1, atom.tokens.length - invocation.args.length);
  if (globals.some((t) => /^--(config-env|exec-path)(=|$)/.test(t))) return true;
  return (atom.prefix ?? []).some((t) => GIT_PROGRAM_ENV.test(t) && !INERT_EDITOR.test(t));
}

/** T343: a git call a worker shouldn't need and that writes where it is told. */
export function gitCheckoutElsewhereReason(args: string[]): string | undefined {
  if (args[0] === 'clone') return 'git clone';
  if (args[0] === 'worktree' && args[1] === 'add') return 'git worktree add';
  if (args[0] === 'submodule' && args.includes('add')) return 'git submodule add';
  return undefined;
}

/**
 * T343: `path` is inside `root` with a `.git` segment: the worktree's gitfile
 * or a `.git` directory. Git's own state, written only through git.
 */
export function isInsideGitDir(path: string, root: string): boolean {
  const resolvedRoot = realpathNearestExisting(resolve(root));
  const rel = relative(resolvedRoot, realpathNearestExisting(resolve(root, path)));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  return rel.split(sep).includes('.git');
}

/** Args from `git`'s subcommand onward, or `undefined` if this isn't a `git` invocation with one. */
export function gitArgs(tokens: string[]): string[] | undefined {
  return parseGitInvocation(tokens).args;
}

const FORCE_PUSH_FLAGS = new Set(['--force', '-f']);

export function isForcePush(args: string[]): boolean {
  if (args[0] !== 'push') return false;
  if (args.some((a) => FORCE_PUSH_FLAGS.has(a) || a.startsWith('--force-with-lease'))) return true;
  // `git push origin +main` — the `+` refspec prefix is shorthand for force.
  return args.slice(1).some((a) => !a.startsWith('-') && a.startsWith('+'));
}

const BRANCH_DELETE_FLAGS = new Set(['-D', '-d', '--delete']);

export function isBranchDelete(args: string[]): boolean {
  if (args[0] === 'branch' && args.some((a) => BRANCH_DELETE_FLAGS.has(a))) return true;
  if (args[0] === 'push' && args.some((a) => BRANCH_DELETE_FLAGS.has(a))) return true;
  return false;
}

export function isGitResetHard(args: string[]): boolean {
  return args[0] === 'reset' && args.includes('--hard');
}

/**
 * Every positional refspec on a `push`, not just the last (appending a
 * safe branch after `main` must not launder a push of `main`). The first
 * positional is the remote. Empty means "current branch to the default
 * remote", never assumed safe.
 */
export function pushRefspecs(args: string[]): string[] {
  if (args[0] !== 'push') return [];
  const positional = args.slice(1).filter((a) => !a.startsWith('-'));
  return positional.slice(1);
}

/** The destination branch of one refspec (`<src>:<dest>` → dest; `+branch` → branch; else the refspec itself). */
export function refspecDestBranch(refspec: string): string {
  const dest = refspec.includes(':') ? (refspec.split(':').at(-1) ?? refspec) : refspec;
  return dest.replace(/^\+/, '');
}

// Other never-without-human commands

export function isRmMinusRf(tokens: string[]): boolean {
  return tokens[0] === 'rm' && tokens.includes('-rf');
}

export function rmTargets(tokens: string[]): string[] {
  return tokens.slice(1).filter((a) => !a.startsWith('-'));
}

export function isSudo(tokens: string[]): boolean {
  return tokens[0] === 'sudo';
}

export function isChmodRecursive777(tokens: string[]): boolean {
  return tokens[0] === 'chmod' && tokens.includes('-R') && tokens.includes('777');
}

/** The state home is never a stream worktree: a direct write to it is never automatic. */
export function touchesAgileState(path: string | undefined): boolean {
  if (path === undefined) return false;
  return path.split(/[\\/]/).includes('.agile');
}

/** Manifests and lockfiles: editing one adds a dependency as surely as `bun add`. */
const MANIFEST_FILENAMES = new Set([
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

export function isManifestPath(path: string | undefined): boolean {
  if (path === undefined) return false;
  return MANIFEST_FILENAMES.has(basename(path));
}

// Redirection / tee

/**
 * Any redirection operator, with or without a leading fd digit or `&`:
 * `>`, `>>`, `<>`, `>|`, `1>`, `2>>`, `&>`, ... No trailing anchor, so a
 * fused target (`1>/etc/x`) still matches.
 *
 * A bare input redirect (`< in.txt`) is deliberately not matched: it only
 * reads, and needs neither containment nor a write deny.
 */
const REDIRECTION_TOKEN_RE = /^(\d+|&)?(>>?|<>|>\|)/;
/** `tee`, any redirection operator (own token or fused), or a `<(...)` process substitution. */
export function hasRedirectionOrTee(tokens: string[]): boolean {
  if (tokens.includes('tee')) return true;
  return tokens.some((t) => REDIRECTION_TOKEN_RE.test(t) || t.startsWith('<('));
}

/** `&1`, `&2`, ... (fd duplication) or `&-` (fd close): a stream operation, no file. */
const FD_DUP_RE = /^&(\d+|-)$/;

/** `/dev/null` or a bare fd form: not a write (`2>&1`, `>/dev/null`), so no role gates it. */
export function isBenignRedirectTarget(target: string | undefined): boolean {
  if (target === undefined) return false;
  return target === '/dev/null' || FD_DUP_RE.test(target);
}

interface RedirectionOccurrence {
  /** The target text (fused or next token), or `undefined` when there is none. */
  target: string | undefined;
}

/** Every redirection operator in `tokens` with its target. `tee` and `<(...)` are checked separately. */
function redirectionOccurrences(tokens: string[]): RedirectionOccurrence[] {
  const occurrences: RedirectionOccurrence[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? '';
    const m = REDIRECTION_TOKEN_RE.exec(t);
    if (!m) continue;
    const rest = t.slice(m[0].length);
    occurrences.push({ target: rest.length > 0 ? rest : tokens[i + 1] });
  }
  return occurrences;
}

/** A redirection with nothing after it is unresolvable, never benign. */
export function hasUnresolvedRedirection(tokens: string[]): boolean {
  return redirectionOccurrences(tokens).some((o) => o.target === undefined);
}

/**
 * Every non-benign redirection target (`cmd > a.txt 2> b.txt` has two),
 * fused or as the next token. An operator with no target contributes
 * nothing here; callers check `hasUnresolvedRedirection` separately.
 */
export function redirectionTargets(tokens: string[]): string[] {
  const targets: string[] = [];
  for (const occ of redirectionOccurrences(tokens)) {
    if (occ.target !== undefined && !isBenignRedirectTarget(occ.target)) targets.push(occ.target);
  }
  return targets;
}

/**
 * Something that writes, or can't be proven not to: `tee`, `<(...)`, an
 * unresolvable redirection, or a redirection to a real file. Benign
 * redirects are excluded. `hasRedirectionOrTee` is the broader "any
 * redirection syntax at all" check.
 */
export function hasWritingRedirectionOrTee(tokens: string[]): boolean {
  if (tokens.includes('tee')) return true;
  if (tokens.some((t) => t.startsWith('<('))) return true;
  if (hasUnresolvedRedirection(tokens)) return true;
  return redirectionTargets(tokens).length > 0;
}

// Benign-command helpers: which tokens are path arguments, per command
// shape (`cat`, `ls`, `cp`, `grep`, `find`, ...). A worker's read scope is
// its own worktree, so even `cat` needs every path containment-checked;
// `policy-tables.ts` does the check and picks the verdict.

function isFlagToken(t: string): boolean {
  return t.startsWith('-');
}

/** True for the closing `]` of a `[ ... ]` test invocation — syntax, not a path. */
function isTestBracketClose(token: string, head: string | undefined): boolean {
  return head === '[' && token === ']';
}

/** Every non-flag positional argument of a plain `cmd arg...`. Not `find`/`grep`-aware. */
export function benignPathArgs(tokens: string[]): string[] {
  const head = tokens[0];
  return tokens.slice(1).filter((t) => !isFlagToken(t) && !isTestBracketClose(t, head));
}

/** `grep`/`rg` path arguments: the first non-flag token is the pattern, the rest are paths. */
export function grepPathArgs(tokens: string[]): string[] {
  const rest = tokens.slice(1).filter((t) => !isFlagToken(t));
  return rest.slice(1);
}

/**
 * `find` actions that write, exec or report to a file (`-delete`, `-exec`,
 * `-ok`, `-fprint`, ...). Present anywhere, they take the command off the
 * benign list entirely.
 */
const FIND_WRITE_FLAGS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprintf',
  '-fls',
]);
export function isFindWriteInvocation(tokens: string[]): boolean {
  return tokens.some((t) => FIND_WRITE_FLAGS.has(t));
}

// Path-bearing flag values: `cp --target-directory=/etc x`,
// `sort --output /etc/x` and `grep -f /etc/passwd` name paths too.

/** Flags whose value (`=value`, fused `-oVALUE`, or the next token) is a path. */
const KNOWN_PATH_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  cp: new Set(['-t', '--target-directory']),
  mv: new Set(['-t', '--target-directory']),
  sort: new Set(['-o', '--output']),
  grep: new Set(['-f', '--file']),
  rg: new Set(['-f', '--file']),
};

const LONG_FLAG_WITH_VALUE_RE = /^--([A-Za-z][A-Za-z0-9-]*)=(.*)$/;

/** Heuristic for an unknown long flag's `=value`: path-like if it has a `/` or starts with `.`/`~`. Not `--width=80`. */
function looksLikePathValue(value: string): boolean {
  if (value.length === 0) return false;
  return (
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~') ||
    value.includes('/')
  );
}

/**
 * Every path-like flag value: a fused `--flag=value` (known flag, or a
 * path-looking value), a known flag's next token, or a known short flag's
 * fused value (`sort -o/etc/x`).
 */
export function flagPathValues(tokens: string[]): string[] {
  const head = tokens[0] ?? '';
  const knownFlags = KNOWN_PATH_VALUE_FLAGS[head] ?? new Set<string>();
  const values: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i] ?? '';
    const eqMatch = LONG_FLAG_WITH_VALUE_RE.exec(t);
    if (eqMatch) {
      const flagName = `--${eqMatch[1] ?? ''}`;
      const value = eqMatch[2] ?? '';
      if (knownFlags.has(flagName) || looksLikePathValue(value)) values.push(value);
      continue;
    }
    if (knownFlags.has(t)) {
      const next = tokens[i + 1];
      if (next !== undefined) values.push(next);
      continue;
    }
    for (const flag of knownFlags) {
      if (flag.length === 2 && !flag.startsWith('--') && t.startsWith(flag) && t.length > 2) {
        values.push(t.slice(2));
      }
    }
  }
  return values;
}

/**
 * `find`'s search roots: the leading non-flag tokens before the first
 * primitive or operator. None means `.` (find's default).
 */
export function findSearchRoots(tokens: string[]): string[] {
  const roots: string[] = [];
  for (const t of tokens.slice(1)) {
    if (isFlagToken(t) || t === '(' || t === ')' || t === '!') break;
    roots.push(t);
  }
  return roots.length > 0 ? roots : ['.'];
}

/**
 * `bunx`/`npx`/`bun x`/`npm exec` prefer an installed local bin, so they
 * are allowed only when the bin is a real executable in this worktree's
 * `node_modules/.bin/` (`isRepoLocalBin`). `pnpm dlx`/`yarn dlx` always
 * fetch into a temporary store, so they are always `hil` (`neverLocal`).
 * A flag that forces a fetch (`-p`, `-y`, `-g`, ...) is always `hil`.
 */
const DLX_FORCE_INSTALL_FLAGS = new Set(['-p', '--package', '-y', '--yes', '-g', '--global']);

/** Any spelling of `-p`/`--package` (including fused forms) forces a fetch. */
function isForceInstallFlag(t: string): boolean {
  if (DLX_FORCE_INSTALL_FLAGS.has(t)) return true;
  if (t.startsWith('--package=')) return true;
  if (t.startsWith('-p') && t.length > 2) return true; // fused -pPKG
  return false;
}

/** The tail tokens for a recognized spelling, plus whether it never consults the local bin. */
function dlxRestTokens(tokens: string[]): { rest: string[]; neverLocal: boolean } | undefined {
  const head = tokens[0];
  if (head === 'bunx' || head === 'npx') return { rest: tokens.slice(1), neverLocal: false };
  if (head === 'bun' && tokens[1] === 'x') return { rest: tokens.slice(2), neverLocal: false };
  if (head === 'npm' && tokens[1] === 'exec') return { rest: tokens.slice(2), neverLocal: false };
  if (head === 'pnpm' && tokens[1] === 'dlx') return { rest: tokens.slice(2), neverLocal: true };
  if (head === 'yarn' && tokens[1] === 'dlx') return { rest: tokens.slice(2), neverLocal: true };
  return undefined;
}

export interface DlxInvocation {
  /** The bin/package name this invocation would run. */
  bin: string;
  /** A fetch-forcing flag was present: always `hil`. */
  forcesInstall: boolean;
  /** `pnpm dlx`/`yarn dlx`: never resolves a local bin, always `hil`. */
  neverLocal: boolean;
}

/** Parses any recognized spelling into `{ bin, forcesInstall, neverLocal }`, or `undefined`. */
export function parseDlxInvocation(tokens: string[]): DlxInvocation | undefined {
  const parsed = dlxRestTokens(tokens);
  if (parsed === undefined) return undefined;
  const { rest, neverLocal } = parsed;
  const forcesInstall = rest.some((t) => isForceInstallFlag(t));
  const bin = rest.find((t) => !isFlagToken(t) && t !== '--');
  if (bin === undefined) return undefined;
  return { bin, forcesInstall, neverLocal };
}

/** A `.bin` entry is a plain identifier: rules out `npx .`, `npx ..` and anything with a `/`. */
const PLAIN_BIN_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/**
 * True only if `bin` is a real, executable, regular file inside this
 * worktree's `node_modules/.bin/`: a plain name, whose `realpath` (and the
 * worktree's) keeps it inside the worktree, so a `.bin` symlink to
 * `/usr/bin` doesn't count. Never throws; any failure means "not local".
 */
export function isRepoLocalBin(bin: string, worktreePath: string): boolean {
  if (!PLAIN_BIN_NAME_RE.test(bin)) return false;
  try {
    const worktreeReal = realpathSync(resolve(worktreePath));
    const candidateReal = realpathSync(resolve(worktreePath, 'node_modules', '.bin', bin));
    if (candidateReal === worktreeReal) return false;
    const rel = relative(worktreeReal, candidateReal);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
    const stats = statSync(candidateReal);
    if (!stats.isFile()) return false;
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

const SCRIPT_LAUNCHER_HEADS = new Set(['node', 'bun']);
/** `node <file>`/`bun <file>` only: `bun`'s own subcommands (`run`, `add`, `x`, ...) are handled elsewhere and must not be read as script names. */
function looksLikeBunSubcommand(token: string): boolean {
  return REPO_SCRIPT_SUBCOMMANDS.has(token) || NEW_DEP_SUBCOMMANDS.has(token) || token === 'x';
}

/** The script path of a direct `node <script>`/`bun <script>`, or `undefined`. */
export function scriptExecutionPath(tokens: string[]): string | undefined {
  const head = tokens[0];
  if (head === undefined || !SCRIPT_LAUNCHER_HEADS.has(head)) return undefined;
  const arg = tokens[1];
  if (arg === undefined || isFlagToken(arg)) return undefined;
  if (head === 'bun' && looksLikeBunSubcommand(arg)) return undefined;
  return arg;
}
