/**
 * Shell-command parsing helpers shared by the policy tables (T010; review
 * fixes per opus's blocking findings 1–3 and the manager's consolidation).
 *
 * Not a full shell parser. It is a **best-effort** classifier for whatever
 * command text this tier of the ACP layer actually receives — see
 * `index.ts`'s file header for why command-level enforcement is primary in
 * T009's PreToolUse hook, not here. Anything this module can't confidently
 * classify (a subshell, a backtick, `eval`, unbalanced quotes) is treated as
 * unclassifiable and routed to `hil`, never `allow` — see
 * `hasUnsafeShellConstruct`.
 */

import { basename, isAbsolute, relative, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Quote-aware splitting/tokenizing
// ---------------------------------------------------------------------------

export type SegmentDelimiter = 'start' | ';' | '&&' | '||' | '|' | '\n';

export interface RawSegment {
  raw: string;
  delimiterBefore: SegmentDelimiter;
}

/**
 * Splits a command string into segments on `;`, `&&`, `||`, `|`, and
 * newlines — but never inside a quoted string, so `sh -c "git push origin
 * main"` stays one segment (its `-c` argument is recursed into separately,
 * see `parseCommandIntoAtoms`).
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
      push('|');
      continue;
    }
    current += c;
  }
  push('start'); // flush the tail; the synthetic 'start' value is discarded (nothing reads past the last push)
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

/** Back-compat alias for the simple whitespace-only case (tests, single-token checks that don't need quote awareness). */
export function tokenize(command: string): string[] {
  return tokenizeSegment(command);
}

// ---------------------------------------------------------------------------
// Unclassifiable shell constructs — hil, never allow (opus blocker 3)
// ---------------------------------------------------------------------------

/**
 * Command substitution (`$(...)`, backticks), `eval`, or unbalanced quotes
 * defeat this tokenizer entirely — there is no sound way to know what will
 * actually run. Treated as unclassifiable: always `hil`, never `allow`,
 * regardless of role.
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

// ---------------------------------------------------------------------------
// Wrapper/env-prefix stripping
// ---------------------------------------------------------------------------

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
/** Leading wrapper commands that don't change what's actually being run, for classification purposes. */
const WRAPPER_COMMANDS = new Set(['command', 'exec', 'nohup', 'time', 'env', 'xargs']);

function normalizeToken(token: string): string {
  return token.startsWith('\\') ? token.slice(1) : token;
}

/** Strips leading `VAR=value` env assignments and wrapper commands (`command`, `exec`, `nohup`, `time`, `env`, `xargs`), and unescapes a leading `\git`-style backslash. */
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

// ---------------------------------------------------------------------------
// Command segmentation into atoms (opus blocker 3: split on control
// operators, recurse into `sh -c "..."`, and remember pipe adjacency so a
// `curl ... | sh` pattern survives being split into separate segments).
// ---------------------------------------------------------------------------

export interface CommandAtom {
  /** Prefix-stripped tokens for this atomic command. */
  tokens: string[];
  /** True if this atom's stdin is the previous atom's stdout (`prev | this`). */
  precededByPipe: boolean;
  /** The immediately preceding atom's tokens, when `precededByPipe`. */
  prevTokens?: string[];
}

const SHELL_RUNNERS = new Set(['sh', 'bash', 'zsh']);

function isShellDashC(tokens: string[]): boolean {
  return SHELL_RUNNERS.has(tokens[0] ?? '') && tokens[1] === '-c' && tokens.length >= 3;
}

/**
 * Splits `command` into atomic commands: control-operator segments
 * (`;`/`&&`/`||`/`|`/newline), each prefix-stripped, with `sh -c "..."` (and
 * `bash`/`zsh`) recursed into so `sh -c "git push origin main"` yields the
 * inner `git push origin main` as its own atom rather than being opaque.
 */
export function parseCommandIntoAtoms(command: string): CommandAtom[] {
  const atoms: CommandAtom[] = [];
  const rawSegments = splitCommandSegments(command);

  for (const seg of rawSegments) {
    const tokens = stripPrefixes(tokenizeSegment(seg.raw));
    if (isShellDashC(tokens)) {
      const nested = parseCommandIntoAtoms(tokens[2] ?? '');
      for (const [idx, atom] of nested.entries()) {
        if (idx === 0) {
          const prev = atoms.at(-1);
          atoms.push({
            tokens: atom.tokens,
            precededByPipe: seg.delimiterBefore === '|',
            prevTokens: seg.delimiterBefore === '|' ? prev?.tokens : undefined,
          });
        } else {
          atoms.push(atom);
        }
      }
      continue;
    }
    const prev = atoms.at(-1);
    atoms.push({
      tokens,
      precededByPipe: seg.delimiterBefore === '|',
      prevTokens: seg.delimiterBefore === '|' ? prev?.tokens : undefined,
    });
  }
  return atoms;
}

/** `curl`/`wget` piped straight into a bare shell (`sh`, `bash`, `zsh` — not `-c`, that's handled by recursion). */
const REMOTE_FETCHERS = new Set(['curl', 'wget']);

export function isPipedIntoBareShell(atom: CommandAtom): boolean {
  return (
    atom.precededByPipe &&
    SHELL_RUNNERS.has(atom.tokens[0] ?? '') &&
    atom.prevTokens !== undefined &&
    REMOTE_FETCHERS.has(atom.prevTokens[0] ?? '')
  );
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/** True if `path` resolves to `root` or somewhere under it. */
export function isPathInside(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(root, path);
  if (resolvedPath === resolvedRoot) return true;
  const rel = relative(resolvedRoot, resolvedPath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Repo scripts / dependency installs
// ---------------------------------------------------------------------------

export const REPO_SCRIPT_RUNNERS = ['bun', 'npm', 'pnpm'] as const;
export type RepoScriptRunner = (typeof REPO_SCRIPT_RUNNERS)[number];

const REPO_SCRIPT_SUBCOMMANDS = new Set(['run', 'test', 'build', 'install', 'i']);
const NEW_DEP_SUBCOMMANDS = new Set(['add', 'install', 'i']);
/** Package managers beyond npm/pnpm/bun — new-dependency installs through these are caught too (opus should-fix 10), just not offered the "existing deps" carve-out (no lockfile convention checked here). */
const OTHER_PACKAGE_MANAGERS = new Set(['yarn', 'pip', 'pip3', 'cargo', 'gem']);
const OTHER_PACKAGE_MANAGER_INSTALL_SUBCOMMANDS = new Set(['add', 'install']);

function isRunner(token: string | undefined): token is RepoScriptRunner {
  return token !== undefined && (REPO_SCRIPT_RUNNERS as readonly string[]).includes(token);
}

/**
 * `bun add`/`npm install <pkg>`/`pnpm add <pkg>` (and `yarn add`/`pip
 * install <pkg>`/`cargo add`/`gem install <pkg>`) add a *new* dependency —
 * never-without-human (§14). A bare `install`/`i` with no package
 * arguments (only flags) restores the existing lockfile and is a normal
 * repo script.
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

// ---------------------------------------------------------------------------
// git — global-option-aware subcommand lookup (opus blocking finding 1)
// ---------------------------------------------------------------------------

/** Global `git` options that take a value, either as a separate token (`-C x`) or joined with `=` (`--git-dir=x`). */
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
  /** Tokens from the subcommand onward (`['push', 'origin', 'main']`), or `undefined` if this isn't `git` or no subcommand was found (e.g. `git -C` with nothing after). */
  args: string[] | undefined;
  /** Every `-C <path>` value seen before the subcommand (there can be more than one; git applies them left to right). */
  cPaths: string[];
}

/**
 * Scans past `git`'s global options (`-C <path>`, `-c k=v`,
 * `--git-dir[=path]`, `--work-tree[=path]`, `--no-pager`, `-p`/`-P`, …) to
 * find the actual subcommand, so `git -C /repo push origin main` is
 * recognized as a `push` rather than mis-read as `args[0] === '-C'`.
 */
export function parseGitInvocation(tokens: string[]): ParsedGitInvocation {
  if (tokens[0] !== 'git') return { args: undefined, cPaths: [] };
  const cPaths: string[] = [];
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i] ?? '';
    if (!t.startsWith('-')) {
      return { args: tokens.slice(i), cPaths };
    }
    const eq = t.indexOf('=');
    const flagName = eq !== -1 ? t.slice(0, eq) : t;
    if (flagName === '-C') {
      const value = eq !== -1 ? t.slice(eq + 1) : tokens[i + 1];
      if (value !== undefined) cPaths.push(value);
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
    // Unrecognized flag: conservatively assume no separate value and keep scanning —
    // worst case we mis-locate the subcommand by one token, which the
    // fallback "not on the never list, not a repo script" deny/hil paths
    // still catch safely (never an allow we didn't mean).
    i += 1;
  }
  return { args: undefined, cPaths };
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
 * Every positional refspec on a `push` (not just the last one — appending
 * the ticket branch after `main` used to launder a push of `main` through
 * `pushTargetBranch`'s old "take the last" logic). The first non-flag
 * positional is treated as the remote; everything after it is a refspec.
 * Empty means "current branch to the default remote" — never assumed safe.
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

const TICKET_BRANCH_PREFIX = 'tkt/';

/**
 * True only for *this ticket's* branch, not any `tkt/*` (opus should-fix
 * 4): the branch must be `tkt/<ticket-id>[-slug]` or `tkt/<numeric>[-slug]`
 * — both spellings are used across this codebase's own fixtures/design
 * (§15 shows `tkt/0231-<slug>`, numeric-only; the ticket's own acceptance
 * fixture uses `tkt/TKT-0001-x`, full-id) — so both are accepted for this
 * specific ticket, but no other ticket's branch is.
 */
export function isTicketBranch(branch: string | undefined, ticket: string): boolean {
  if (branch === undefined || !branch.startsWith(TICKET_BRANCH_PREFIX)) return false;
  const rest = branch.slice(TICKET_BRANCH_PREFIX.length);
  const numeric = ticket.replace(/^TKT-/, '');
  return (
    rest === ticket ||
    rest.startsWith(`${ticket}-`) ||
    rest === numeric ||
    rest.startsWith(`${numeric}-`)
  );
}

// ---------------------------------------------------------------------------
// Other never-without-human commands
// ---------------------------------------------------------------------------

/** `rm`/`rm -rf ...` targets, ignoring flags. */
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

/** `.agile/` sits under the state worktree, not a ticket worktree — a direct write to it is never automatic (§14). */
export function touchesAgileState(path: string | undefined): boolean {
  if (path === undefined) return false;
  return path.split(/[\\/]/).includes('.agile');
}

/** Dependency manifests/lockfiles — an in-worktree *edit* to one of these adds a dependency just as surely as `bun add` does (opus should-fix 5). */
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

// ---------------------------------------------------------------------------
// Redirection / tee (opus blocking finding 2)
// ---------------------------------------------------------------------------

/**
 * Matches any redirection operator, with or without a leading file
 * descriptor digit or `&` (review round 2, opus R2-1): `>`, `>>`, `<>`,
 * `>|`, and fd-prefixed/combined forms `1>`, `2>`, `2>>`, `&>`, `&>>`. A
 * plain whitespace-only `/^>{1,2}/` (round-1's check) never matched `1>`/
 * `2>`/`&>`, so `cat f 1> g` and `npm run build 1>/etc/x` were invisible to
 * both the reviewer/QA outright-deny and the engineer's worktree-containment
 * check. `test()`/`exec()` intentionally have no trailing anchor — a fused
 * target (`1>/etc/x`) still starts with the operator, and that's the case
 * that matters.
 */
const REDIRECTION_TOKEN_RE = /^(\d+|&)?(>>?|<>|>\|)/;

/** `tee`, a redirection operator token (any form `REDIRECTION_TOKEN_RE` matches, as its own token or fused onto the target), or a `<(...)` process substitution. */
export function hasRedirectionOrTee(tokens: string[]): boolean {
  if (tokens.includes('tee')) return true;
  return tokens.some((t) => REDIRECTION_TOKEN_RE.test(t) || t.startsWith('<('));
}

const FD_DUP_RE = /^&\d+$/;

/**
 * Every redirection's target in `tokens` — there can be more than one
 * (`cmd > a.txt 2> b.txt`, round-2 "newly visible" finding: the round-1
 * version only checked the first) — whether fused onto the operator
 * (`>out.txt`, `1>/etc/x`) or given as the following token. A bare
 * fd-duplication target (`2>&1` — no real file, just a stream merge) is
 * skipped: there is nothing on disk to contain.
 */
export function redirectionTargets(tokens: string[]): string[] {
  const targets: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? '';
    const m = REDIRECTION_TOKEN_RE.exec(t);
    if (!m) continue;
    const rest = t.slice(m[0].length);
    if (rest.length > 0) {
      if (!FD_DUP_RE.test(rest)) targets.push(rest);
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !FD_DUP_RE.test(next)) targets.push(next);
  }
  return targets;
}

/** The first redirection target, if any — see `redirectionTargets` for the full (possibly multi-target) picture. */
export function redirectionTarget(tokens: string[]): string | undefined {
  return redirectionTargets(tokens)[0];
}
