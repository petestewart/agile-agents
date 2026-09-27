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

import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_PERMISSION_POSTURE,
  type PermissionPosture,
  READ_ROOT_MAX_CHARS,
  type ReposConfig,
  type Stream,
} from '@agile-agents/shared';
import * as cmd from './command';
import { isPathInside, realpathNearestExisting } from './command';
import type { PermissionRequest, PermissionRole } from './types';

/**
 * T457: a read the Ask posture holds for the human. `root` is the dir an
 * "Always for this project" answer adds (`alwaysReadRoot`); absent when
 * there is none worth offering (`/`, the home dir).
 */
export interface ReadAsk {
  path: string;
  root?: string;
}

export type PolicyVerdict =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'hil'; reason: string; readAsk?: ReadAsk };

const ALLOW: PolicyVerdict = { action: 'allow' };
function deny(reason: string): PolicyVerdict {
  return { action: 'deny', reason };
}
function hil(reason: string): PolicyVerdict {
  return { action: 'hil', reason };
}

/** T339: a held tool fetch or install points at the repo's own check commands. */
function fetchHil(reason: string, worktreePath: string): PolicyVerdict {
  const checks = cmd.repoScriptChecks(worktreePath);
  const hint =
    checks.length > 0
      ? `use the repo's own scripts instead: ${checks.join(', ')}`
      : "use the repo's own check commands from your brief instead";
  return hil(`${reason}; ${hint}`);
}

export interface PolicyContext {
  role: PermissionRole;
  worktreePath: string;
  /** T213: where a read may reach beyond the worktree (visible registered repos). */
  readRoots?: readonly string[];
  /** T213: never readable unless inside the worktree: private repos not shared with the node, and the agile home. */
  hiddenRoots?: readonly string[];
  /**
   * T457: what a read outside every root gets: `trusted` allows it, `ask`
   * holds it for the human (`hil` with a `readAsk`). Absent (the Director, a
   * bare test context): denied, as before T457.
   */
  posture?: PermissionPosture;
}

/**
 * T457: credential locations no agent reads under any posture, relative to
 * the user's home dir (`/proc` is absolute: another process's environ holds
 * its keys). Checked right after the node's own worktree, before any read
 * root, so neither Trusted nor a registered repo or an "Always" root that
 * contains one opens it. An entry ending in `*` matches every name in its
 * dir that starts with the rest. The one list of them: add a location here.
 */
export const CREDENTIAL_PATHS: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.password-store',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.kube/config',
  '.docker/config.json',
  '.netrc',
  '.git-credentials',
  '.config/gh',
  '.config/hub',
  '.npmrc',
  '.pypirc',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.terraform.d/credentials.tfrc.json',
  'Library/Keychains',
  // The vendor logins the adapters spawn with (the user's own, never an agent's to read).
  '.claude/.credentials*',
  '.claude.json',
  '.codex/auth.json',
  '.gemini/oauth_creds.json',
  '.config/cursor/auth.json',
  '.pi/agent/auth.json',
  '/proc',
];

/**
 * T457: a path in the two spellings the deny side compares: as written
 * (resolved) and as its symlinks resolve, each with case and Unicode
 * normalisation folded, since a case-insensitive disk (macOS) opens
 * `~/.AGILE` as `~/.agile`. Only ever used to refuse, never to allow.
 */
function spellings(path: string): [string, string] {
  const fold = (p: string) => p.normalize('NFC').toLowerCase();
  return [fold(resolve(path)), fold(realpathNearestExisting(path))];
}

/** `path` is `root` or under it (both already folded). */
function under(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** T457: `path` is `root` or inside it in either spelling (`spellings`). */
function insideEither(path: string, root: string): boolean {
  const [pathLex, pathReal] = spellings(path);
  const [rootLex, rootReal] = spellings(root);
  return under(pathLex, rootLex) || under(pathReal, rootReal);
}

/** Each `CREDENTIAL_PATHS` entry as an absolute path, and the name prefix a `*` entry matches. */
function credentialEntries(home: string): Array<{ path: string; prefix?: string }> {
  return CREDENTIAL_PATHS.map((entry) => {
    const abs = isAbsolute(entry) ? entry : join(home, entry);
    return abs.endsWith('*')
      ? { path: dirname(abs), prefix: basename(abs).slice(0, -1).toLowerCase() }
      : { path: abs };
  });
}

/** T457: `path` (absolute) is one of `CREDENTIAL_PATHS` or inside one, in either spelling. */
export function isCredentialPath(path: string, home: string = homedir()): boolean {
  const [pathLex, pathReal] = spellings(path);
  return credentialEntries(home).some((entry) => {
    const [rootLex, rootReal] = spellings(entry.path);
    if (entry.prefix === undefined) return under(pathLex, rootLex) || under(pathReal, rootReal);
    // A `*` entry: the first name under its dir starts with the prefix.
    const first = (p: string, root: string) =>
      under(p, root) && (relative(root, p).split(sep)[0] ?? '').startsWith(entry.prefix ?? '');
    return first(pathLex, rootLex) || first(pathReal, rootReal);
  });
}

/**
 * T457: why a read that walks `dir` (a recursive grep, a pattern's fixed
 * prefix) could reach something no read may: a hidden root (the agile home,
 * another project's private repo) or a credential location inside it.
 */
function walkReachesProtected(
  dir: string,
  ctx: Pick<PolicyContext, 'hiddenRoots'>,
  home: string = homedir(),
): string | undefined {
  const [dirLex, dirReal] = spellings(dir);
  const protectedRoots = [
    ...(ctx.hiddenRoots ?? []),
    ...credentialEntries(home).map((entry) => entry.path),
  ];
  const reached = protectedRoots.find((root) => {
    const [rootLex, rootReal] = spellings(root);
    return under(rootLex, dirLex) || under(rootReal, dirReal);
  });
  return reached;
}

/** Shell pattern characters: a path with one expands to paths the literal text doesn't name. */
const PATTERN_CHARS = /[*?[\]{}]/;

/**
 * T457, T459: a glob or brace pattern whose matches can leave the dir its
 * fixed prefix names: a `..` segment after the first pattern character, a
 * segment like `.*` (matches `..` in older shells), or a brace group with a
 * `.` or `/` in it (`{b,../../x}`). Its literal text resolves inside, so a
 * lexical check alone would pass it.
 */
function patternClimbs(path: string): boolean {
  const at = path.search(PATTERN_CHARS);
  if (at < 0) return false;
  const rest = path.slice(path.lastIndexOf('/', at) + 1);
  const segments = rest.split('/');
  return (
    segments.includes('..') ||
    segments.some((segment) => /^\.[*?[]/.test(segment)) ||
    /\{[^}]*[./][^}]*\}/.test(rest)
  );
}

/**
 * T457: a read path with a glob or brace pattern expands to paths its
 * literal text doesn't name, so the literal check alone can't hold. What it
 * can reach is bounded by its fixed prefix (the dirs before the first
 * pattern character), unless the pattern can climb out of it: a `..`
 * segment after a glob (through a symlinked match the kernel climbs from
 * the target), a segment like `.*` (matches `..` in older shells), or a
 * brace alternative with a `.` or `/` (`{.,.}{.,.}`, `{a,../x}`). Returns
 * the deny, or `undefined` for a plain path or a pattern whose prefix
 * reaches nothing protected.
 */
function patternReadVerdict(
  expanded: string,
  raw: string,
  ctx: Pick<PolicyContext, 'worktreePath' | 'hiddenRoots'>,
): PolicyVerdict | undefined {
  const at = expanded.search(PATTERN_CHARS);
  if (at < 0) return undefined;
  const cut = expanded.lastIndexOf('/', at);
  const rest = expanded.slice(cut + 1);
  if (patternClimbs(expanded)) {
    return deny(`"${raw}" is a pattern that may climb out of its dir: name the path without it`);
  }
  const prefix =
    cut < 0 ? ctx.worktreePath : resolve(ctx.worktreePath, expanded.slice(0, cut) || '/');
  const reached = walkReachesProtected(prefix, ctx);
  if (reached !== undefined) {
    return deny(
      `"${raw}" is a pattern over ${prefix}, which holds ${reached} (the agile home, a private repo or credentials): narrow it`,
    );
  }
  // Outside the worktree, what it matches now: a match through a symlink into
  // something protected is refused as its literal path would be.
  if (isPathInside(prefix, ctx.worktreePath)) return undefined;
  let count = 0;
  try {
    const matches = new Bun.Glob(rest).scanSync({
      cwd: prefix,
      absolute: true,
      onlyFiles: false,
      followSymlinks: true,
    });
    for (const match of matches) {
      if (++count > PATTERN_MATCHES_MAX) {
        return deny(`"${raw}" matches over ${PATTERN_MATCHES_MAX} paths: narrow it`);
      }
      if (isCredentialPath(match) || (ctx.hiddenRoots ?? []).some((h) => insideEither(match, h))) {
        return deny(
          `"${raw}" matches ${match}, in the agile home, a private repo or credentials: narrow it`,
        );
      }
    }
  } catch {
    return deny(`"${raw}" is a pattern that could not be expanded to check: name the paths`);
  }
  return undefined;
}

/** T457: how many matches of a read pattern outside the worktree are checked before it is refused as too wide. */
const PATTERN_MATCHES_MAX = 2000;

/**
 * T457: how a read tool walks what it is given: not at all, every file
 * under it (`grep -r`, `rg`), or also through the symlinks it meets
 * (`grep -R`, `rg -L`, `diff -r`), which no check of the named dir can see.
 */
function walkMode(tokens: readonly string[]): ReadOptions['walks'] {
  const head = tokens[0];
  const short = (letter: string) =>
    tokens
      .slice(1)
      .some((t) => /^-[^-]/.test(t) && (t.slice(1).split('=')[0] ?? '').includes(letter));
  if (head === 'grep') {
    return tokens.includes('--dereference-recursive') || short('R') ? 'follows' : true;
  }
  if (head === 'rg') return tokens.includes('--follow') || short('L') ? 'follows' : true;
  if (head === 'diff') return tokens.includes('--recursive') || short('r') ? 'follows' : true;
  return false;
}

/**
 * T457: `~` and `~/rest` expanded against the real home (a built-in Read
 * may be handed one); `~user` can't be placed.
 */
function expandHome(raw: string): string | undefined {
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  if (raw.startsWith('~')) return undefined;
  return raw;
}

/**
 * T457: `raw` walked as the kernel walks it: each existing segment
 * `realpath`'d before a later `..` applies, so `<link>/../x` lands beside
 * the link's target. `resolve` alone cancels the `..` against the link's
 * own name.
 */
function physicalPath(raw: string, base: string): string {
  const full = isAbsolute(raw) ? raw : `${base}/${raw}`;
  let current = '/';
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    try {
      current = realpathSync(next);
    } catch {
      current = next;
    }
  }
  return current;
}

/**
 * T457: the dir "Always for this project" adds for a read of `path`: the
 * path itself when it is a directory, else its parent. Never `/`, the home
 * dir or a dir above it: then `undefined`, and the card offers only Allow
 * once and Deny.
 */
export function alwaysReadRoot(path: string, home: string = homedir()): string | undefined {
  let dir = resolve(path);
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    dir = dirname(dir);
  }
  return readRootRefusal(dir, home) === undefined ? dir : undefined;
}

/** T457: why `root` can't be a project's read root (`/`, the home dir or above it), or `undefined`. */
export function readRootRefusal(root: string, home: string = homedir()): string | undefined {
  if (!isAbsolute(root) || resolve(root) === '/') return `${root}: a read root is a dir below /`;
  if (root.length > READ_ROOT_MAX_CHARS) return `${root}: too long for a read root`;
  if (isPathInside(resolve(home), root)) {
    return `${root}: the home dir or a dir above it is too wide for a read root (use Trusted)`;
  }
  return undefined;
}

type ReadScopeContext = Pick<
  PolicyContext,
  'worktreePath' | 'readRoots' | 'hiddenRoots' | 'posture'
>;

/** One resolved path's verdict (`readVerdict` runs it on the lexical and the physical path). */
function readVerdictAt(path: string, raw: string, ctx: ReadScopeContext): PolicyVerdict {
  if (isPathInside(path, ctx.worktreePath)) return ALLOW;
  if (isCredentialPath(path)) {
    return deny(`${raw} holds credentials: no agent reads it, whatever the permission setting`);
  }
  // The deepest root wins (as P13's visibility check): a readable repo nested
  // inside a hidden one stays readable.
  const readable = (ctx.readRoots ?? []).filter((root) => isPathInside(path, root));
  const hidden = (ctx.hiddenRoots ?? []).filter((root) => insideEither(path, root));
  if (hidden.some((h) => !readable.some((r) => r !== h && isPathInside(r, h)))) {
    return deny(`${raw} is in the agile home or a private repo this node's project cannot read`);
  }
  if (readable.length > 0) return ALLOW;
  if (ctx.posture === 'trusted') return ALLOW;
  if (ctx.posture === 'ask') {
    const root = alwaysReadRoot(path);
    return {
      action: 'hil',
      reason: `${raw} is outside every repo this node can read, and reads elsewhere ask the human first (permissions: Ask)`,
      readAsk: { path, ...(root !== undefined ? { root } : {}) },
    };
  }
  return deny(`${raw} is outside the worktree and every repo this node can read`);
}

/** Deny beats hil beats allow. */
function stricter(a: PolicyVerdict, b: PolicyVerdict): PolicyVerdict {
  const rank = (v: PolicyVerdict) => (v.action === 'deny' ? 2 : v.action === 'hil' ? 1 : 0);
  return rank(b) > rank(a) ? b : a;
}

/**
 * T213, T457: the verdict on a read of `raw` (absolute, relative to the
 * worktree, or `~`-rooted). An allow-list: the own worktree (or session
 * dir); never a credential location; never under a hidden root (the agile
 * home, other projects' private repos); then any read root; then the
 * posture: Trusted allows, Ask holds it for the human, none denies. A path
 * with a `..` must pass both as written and as the kernel walks it.
 */
export function readVerdict(
  raw: string,
  ctx: ReadScopeContext,
  options: ReadOptions = {},
): PolicyVerdict {
  const expanded = expandHome(raw);
  if (expanded === undefined) return deny(`cannot resolve the path "${raw}"`);
  const pattern = patternReadVerdict(expanded, raw, ctx);
  if (pattern !== undefined) return pattern;
  const climbs = expanded.split('/').includes('..');
  const targets = [
    resolve(ctx.worktreePath, expanded),
    ...(climbs ? [physicalPath(expanded, ctx.worktreePath)] : []),
  ];
  if (options.walks !== undefined && options.walks !== false) {
    for (const target of targets) {
      if (options.walks === 'follows' && !isPathInside(target, ctx.worktreePath)) {
        return deny(
          `${raw}: a recursive read that follows symlinks (grep -R, rg -L, diff -r) can't be checked outside the worktree; drop that flag or search inside the worktree`,
        );
      }
      const reached = walkReachesProtected(target, ctx);
      if (reached !== undefined) {
        return deny(
          `a recursive read of ${raw} would reach ${reached} (the agile home, a private repo or credentials): search a narrower dir`,
        );
      }
    }
  }
  return targets.map((target) => readVerdictAt(target, raw, ctx)).reduce((a, b) => stricter(a, b));
}

/** T457: how a read goes. */
export interface ReadOptions {
  /**
   * It reads every file under the path (`grep -r`, `rg`, the Grep tool):
   * nothing protected may be under it. `follows`: through symlinks too
   * (`walkMode`), so only inside the worktree.
   */
  walks?: boolean | 'follows';
}

/** T213: why a read of `raw` is refused (a held Ask read included), or `undefined` when it may be read. */
export function readDenyReason(raw: string, ctx: ReadScopeContext): string | undefined {
  const verdict = readVerdict(raw, ctx);
  return verdict.action === 'allow' ? undefined : verdict.reason;
}

/** T457: every path's verdict at once: any deny wins, then the first held read, else allow. */
export function readPathsVerdict(
  paths: readonly string[],
  ctx: ReadScopeContext,
  options: ReadOptions = {},
): PolicyVerdict {
  let held: PolicyVerdict | undefined;
  for (const path of paths) {
    const verdict = readVerdict(path, ctx, options);
    if (verdict.action === 'deny') return verdict;
    if (verdict.action === 'hil') held ??= verdict;
  }
  return held ?? ALLOW;
}

/** T457: a read the Ask posture holds; the rest of the command is still checked before it is asked. */
function isHeldRead(verdict: PolicyVerdict): boolean {
  return verdict.action === 'hil' && verdict.readAsk !== undefined;
}

/** T457: a project's read settings, as `nodeReadScope` needs them. */
export interface ProjectReadSettings {
  posture?: PermissionPosture;
  /** The project's "Always" roots. */
  readRoots?: readonly string[];
}

/**
 * T213, T330 (projects-design §4.4, P20), T457: a node's read scope, for
 * the hook and the ACP responder alike. Any registered repo is readable
 * except a private one its project isn't listed on; the agile home never is
 * (the session's own dir, its cwd, is allowed before any root is checked).
 * The project's "Always" roots are read roots too, unless one lies inside a
 * hidden root. The posture is the project's, else the home's, else Ask
 * (`settings`). An unreadable registry reads nothing beyond the cwd.
 */
export function nodeReadScope(
  node: Pick<Stream, 'repo' | 'project'> | undefined,
  readRepos: () => ReposConfig,
  agileHome: string | undefined,
  settings?: (project: string | undefined) => ProjectReadSettings,
): { readRoots: string[]; hiddenRoots: string[]; posture: PermissionPosture } {
  const readRoots: string[] = [];
  const hiddenRoots: string[] = [];
  let repos: ReposConfig = {};
  try {
    repos = readRepos();
  } catch {
    // Fail closed: only the cwd.
  }
  for (const [name, entry] of Object.entries(repos)) {
    const visibility = entry.visibility;
    const visible =
      name === node?.repo ||
      visibility === undefined ||
      visibility.mode === 'public' ||
      (node?.project !== undefined &&
        (visibility.projects as readonly string[]).includes(node.project));
    (visible ? readRoots : hiddenRoots).push(entry.path);
  }
  // The home holds the classifier key and every node's state: never a read target.
  if (agileHome !== undefined) hiddenRoots.push(agileHome);
  let project: ProjectReadSettings = {};
  try {
    project = settings?.(node?.project) ?? {};
  } catch {
    // Unreadable settings: Ask, and no extra roots.
  }
  for (const root of project.readRoots ?? []) {
    // An "Always" root inside a hidden one would open it (the nested-repo exception): never.
    if (!hiddenRoots.some((hidden) => isPathInside(root, hidden))) readRoots.push(root);
  }
  return { readRoots, hiddenRoots, posture: project.posture ?? DEFAULT_PERMISSION_POSTURE };
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
    return fetchHil('installing a new dependency is never automatic', ctx.worktreePath);
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
    // T345: `cd <name>` then goes wherever CDPATH points.
    if (cmd.mentionsCdpath(classified.command)) {
      return hil('a command that sets or names CDPATH is never automatic');
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
  'tree',
]);

/** T213: of those, the ones that only read, so any `readRoots` path is fine (`sort -o` writes). */
const ENGINEER_READ_ONLY_PATH_TOOLS = new Set([
  'cat',
  'ls',
  'head',
  'tail',
  'wc',
  'cut',
  'diff',
  'tree',
]);

/** T345: `tree -o <file>` writes its listing, and `-R` writes `00Tree.html` into every dir. */
function treeWrites(tokens: string[]): boolean {
  return (
    tokens[0] === 'tree' && tokens.some((t) => /^-[^-]*[oR]/.test(t) || t.startsWith('--output'))
  );
}

/**
 * Every path must resolve inside the worktree after `~` expansion
 * (`cmd.resolveTargetPath`); a `$`, backtick or `~user` is unclassifiable
 * and routes to `hil`, never a guessed allow.
 */
/** T343: why a write to `path` is refused when it lands in git's own state, else `undefined`. */
function gitDirWriteDenyReason(path: string, ctx: PolicyContext): string | undefined {
  return cmd.isInsideGitDir(path, ctx.worktreePath)
    ? `${path} is git's own state (.git): change it through git, not by writing into it`
    : undefined;
}

/** T345: every dir an atom may run in; a path must hold from each. */
type Cwds = readonly string[];
const MAX_CWDS = 16;

/** `path` as seen from `cwd`: unchanged from the worktree itself (so reasons keep the raw path). */
function fromCwd(path: string, cwd: string, ctx: PolicyContext): string {
  return cwd === ctx.worktreePath ? path : resolve(cwd, path);
}

function verifyBenignPaths(
  paths: string[],
  ctx: PolicyContext,
  reads = false,
  cwds: Cwds = [ctx.worktreePath],
  /** T457: the tool reads every file under each path (`walkMode`). */
  walks: ReadOptions['walks'] = false,
): PolicyVerdict {
  // T457: a held Ask read waits until every other path has had its say (a deny wins).
  let held: PolicyVerdict | undefined;
  for (const raw of paths) {
    const resolved = cmd.resolveTargetPath(raw);
    if (!resolved.safe) {
      return hil(
        `"${raw}" contains an unresolved shell variable/backtick/home-directory reference`,
      );
    }
    for (const cwd of cwds) {
      const path = fromCwd(resolved.path, cwd, ctx);
      if (reads) {
        const verdict = readVerdict(path, ctx, { walks });
        if (verdict.action === 'deny') return verdict;
        if (verdict.action === 'hil') held ??= verdict;
      } else if (patternClimbs(resolved.path)) {
        // T459: `touch a/{b,../../x}` reads as inside the worktree but writes outside it.
        return deny(`"${raw}" is a pattern that may write outside the worktree: name each path`);
      } else if (!isPathInside(path, ctx.worktreePath)) {
        return deny(`${raw} is outside the worktree`);
      } else {
        const reason = gitDirWriteDenyReason(path, ctx);
        if (reason !== undefined) return deny(reason);
      }
    }
  }
  return held ?? ALLOW;
}

/** The benign-command verdict for one atom, or `undefined` if it is none of these shapes (the caller denies). */
function engineerBenignCommandVerdict(
  atom: cmd.CommandAtom,
  ctx: PolicyContext,
  cwds: Cwds,
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
      return fetchHil(
        `"${dlx.bin}" forces a package install/global run (-p/--package/-y/--yes/-g/--global)`,
        ctx.worktreePath,
      );
    }
    if (dlx.neverLocal) {
      return fetchHil(
        `"${dlx.bin}" via dlx always fetches into a temporary store, never the local node_modules/.bin`,
        ctx.worktreePath,
      );
    }
    return cmd.isRepoLocalBin(dlx.bin, ctx.worktreePath)
      ? ALLOW
      : fetchHil(
          `"${dlx.bin}" is not an existing repo-local bin (node_modules/.bin)`,
          ctx.worktreePath,
        );
  }

  if (head === 'find') {
    if (cmd.isFindWriteInvocation(tokens)) return undefined; // write primitives: not benign
    return verifyBenignPaths(cmd.findSearchRoots(tokens), ctx, true, cwds);
  }

  if (head === 'grep' || head === 'rg') {
    // `rg --pre <cmd>` runs a command on every file: not a read.
    if (runsPreprocessor(tokens)) return undefined;
    return verifyBenignPaths(
      [...cmd.grepPathArgs(tokens), ...cmd.flagPathValues(tokens)],
      ctx,
      true,
      cwds,
      walkMode(tokens),
    );
  }

  const scriptPath = cmd.scriptExecutionPath(tokens);
  if (scriptPath !== undefined) {
    return verifyBenignPaths([scriptPath], ctx, false, cwds);
  }

  if (ENGINEER_BENIGN_PATH_TOOLS.has(head)) {
    if (treeWrites(tokens)) return undefined;
    return verifyBenignPaths(
      [...cmd.benignPathArgs(tokens), ...cmd.flagPathValues(tokens)],
      ctx,
      ENGINEER_READ_ONLY_PATH_TOOLS.has(head),
      cwds,
      walkMode(tokens),
    );
  }

  return undefined;
}

/**
 * T343: any git argument that may be a path must resolve inside the worktree
 * and outside `.git`, whatever the subcommand; otherwise it is held.
 */
function engineerGitPathVerdict(
  args: string[],
  ctx: PolicyContext,
  cwds: Cwds,
): PolicyVerdict | undefined {
  for (const cwd of cwds) {
    for (const raw of cmd.gitPathArguments(args, cwd)) {
      const resolved = cmd.resolveTargetPath(raw);
      const path = resolved.safe ? fromCwd(resolved.path, cwd, ctx) : '';
      if (
        !resolved.safe ||
        !isPathInside(path, ctx.worktreePath) ||
        cmd.isInsideGitDir(path, ctx.worktreePath)
      ) {
        return hil(
          `git argument "${raw}" may be a path outside the worktree or into .git: never automatic`,
        );
      }
    }
  }
  return undefined;
}

/** T345: a `cd` target the shell may look up in CDPATH (or as a cdable_vars name). */
function isBareCdName(target: string): boolean {
  return !/^(\/|~|\.\.?(\/|$))/.test(target);
}

/**
 * T336, T345: `cd <dir>` resolved from `cwd`, or why it is refused: no
 * dir, `cd -`, a flag, extra words, a path the shell must expand, or a bare
 * name, which CDPATH or cdable_vars in the user's shell could send anywhere.
 */
function cdTarget(tokens: string[], cwd: string, role: string): { dir: string } | PolicyVerdict {
  const [, target, ...rest] = tokens;
  if (target === undefined || target === '-' || target.startsWith('-') || rest.length > 0) {
    return deny(`${role} role allows cd only as \`cd <dir>\``);
  }
  const resolved = cmd.resolveTargetPath(target);
  if (!resolved.safe) return deny(`${role} role cannot resolve the path "${target}"`);
  if (isBareCdName(target)) {
    return deny(`use \`cd ./${target}\` (a bare name can be redirected by CDPATH)`);
  }
  return { dir: resolve(cwd, resolved.path) };
}

/**
 * T336, T345: each atom of `command` that isn't a `cd`, with every dir it
 * may run in, or the verdict that stops the walk. `cd` checks each target.
 * After `&&` only a `cd` that succeeded matters, so its target replaces the
 * set; after `;`, `||`, `&`, a pipe or inside `sh -c`, a failed or subshell
 * `cd` leaves the shell where it was, so the atom may run in any dir seen.
 */
function* walkCwds(
  command: string,
  start: string,
  cd: (tokens: string[], cwd: string) => { dir: string } | PolicyVerdict,
): Generator<{ atom: cmd.CommandAtom; cwds: Cwds } | PolicyVerdict> {
  if (cmd.mentionsCdpath(command)) {
    yield deny('a command that sets CDPATH is never automatic');
    return;
  }
  let all: Cwds = [start];
  let current: Cwds = [start];
  const atoms = cmd.parseCommandIntoAtoms(command);
  for (const [i, atom] of atoms.entries()) {
    const here = atom.delimiterBefore === '&&' && atom.nested !== true ? current : all;
    current = here;
    if (atom.tokens[0] !== 'cd') {
      yield { atom, cwds: here };
      continue;
    }
    const dirs: string[] = [];
    for (const cwd of here) {
      const moved = cd(atom.tokens, cwd);
      if ('action' in moved) {
        yield moved;
        return;
      }
      dirs.push(moved.dir);
    }
    const inPipeline = atom.precededByPipe || atoms[i + 1]?.precededByPipe === true;
    const certain = atom.nested !== true && !inPipeline;
    current = [...new Set(certain ? dirs : [...here, ...dirs])];
    all = [...new Set([...all, ...dirs])];
    // Fail closed on a chain too long to follow, so it can't stall the hook.
    if (all.length > MAX_CWDS) {
      yield deny('too many cd in one command to check');
      return;
    }
  }
}

/**
 * T345: a worker's `cd`: into its own worktree, never `.git`. The new dir is
 * `realpath`'d, as the kernel resolves a later `..` from the physical dir.
 */
function engineerCd(
  tokens: string[],
  ctx: PolicyContext,
  cwd: string,
): { dir: string } | PolicyVerdict {
  const moved = cdTarget(tokens, cwd, 'engineer');
  if ('action' in moved) return moved;
  if (!isPathInside(moved.dir, ctx.worktreePath)) {
    return deny(`cd ${tokens[1]} leaves the worktree`);
  }
  if (cmd.isInsideGitDir(moved.dir, ctx.worktreePath)) {
    return deny(`cd ${tokens[1]} goes into git's own state (.git)`);
  }
  try {
    return { dir: realpathSync(moved.dir) };
  } catch {
    return moved; // not there yet: the cd will fail
  }
}

function engineerExecuteVerdict(command: string, ctx: PolicyContext): PolicyVerdict {
  const cd = (tokens: string[], cwd: string) => engineerCd(tokens, ctx, cwd);
  // T457: a held Ask read is asked only once every atom after it has passed.
  let held: PolicyVerdict | undefined;
  for (const step of walkCwds(command, ctx.worktreePath, cd)) {
    if ('action' in step) return step;
    const { atom, cwds } = step;
    // T459: `… | xargs cat` runs on paths no check here can see.
    if (cmd.runsUnderXargs(atom)) {
      return hil(
        'xargs runs a command on paths known only when it runs: pass the paths directly (or use grep -r / find), or ask the human',
      );
    }
    // T459: an input redirect's file is read like an argument (`cat <f`, `tr a b < f`).
    const inputs = verifyBenignPaths(cmd.inputRedirectTargets(atom.tokens), ctx, true, cwds);
    if (isHeldRead(inputs)) held ??= inputs;
    else if (inputs.action !== 'allow') return inputs;
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
        for (const cwd of cwds) {
          const path = fromCwd(resolved.path, cwd, ctx);
          if (!isPathInside(path, ctx.worktreePath)) {
            return deny(
              'redirected output escapes the worktree (or uses tee/process substitution)',
            );
          }
          const reason = gitDirWriteDenyReason(path, ctx);
          if (reason !== undefined) return deny(reason);
        }
      }
      // A safe redirect doesn't make the command allowed: still classify it.
    }
    if (cmd.isRepoScriptCommand(atom.tokens)) continue;
    const gitArgs = cmd.gitArgs(atom.tokens);
    if (gitArgs !== undefined) {
      // T343: repo config is shared with the reviewer, the daemon and the
      // human's own git (a hook, fsmonitor or pager there runs a program).
      if (cmd.isGitConfigWrite(gitArgs)) {
        return hil('git config that sets or removes a value is never automatic');
      }
      if (cmd.gitProgramOverride(atom)) {
        return hil('git config overrides that can run programs need the operator');
      }
      const redirect = cmd.gitDirRedirectReason(atom);
      if (redirect !== undefined) return hil(`${redirect}: never automatic`);
      const written = verifyBenignPaths(cmd.gitWriteTargets(gitArgs), ctx, false, cwds);
      if (written.action !== 'allow') return written;
      if (gitArgs.includes('--unsafe-paths')) {
        return deny(
          "git --unsafe-paths turns off git apply's own guard against writing outside the worktree",
        );
      }
      const elsewhere = cmd.gitCheckoutElsewhereReason(gitArgs);
      if (elsewhere !== undefined) {
        return hil(`${elsewhere} writes a checkout wherever it is told: never automatic`);
      }
      const pathVerdict = engineerGitPathVerdict(gitArgs, ctx, cwds);
      if (pathVerdict !== undefined) return pathVerdict;
      // Any git not on the never-without-human list: the worker's own branch work.
      continue;
    }
    const benign = engineerBenignCommandVerdict(atom, ctx, cwds);
    if (benign !== undefined) {
      if (benign.action === 'allow') continue;
      if (isHeldRead(benign)) {
        held ??= benign;
        continue;
      }
      return benign;
    }
    return deny(`${atom.tokens[0] ?? command} is not an allowed command for the engineer role`);
  }
  return held ?? ALLOW;
}

function engineerVerdict(classified: PermissionRequest, ctx: PolicyContext): PolicyVerdict {
  switch (classified.toolClass) {
    case 'read': {
      // Reads are never gated by ACP (spike-findings §A), but answer
      // consistently: under a read scope (T330), as the hook's Read would.
      if (!hasReadScope(ctx)) return ALLOW;
      return readPathsVerdict(allTargetPaths(classified), ctx);
    }
    case 'edit': {
      // Every path must resolve inside the worktree, not just the first.
      const paths = allTargetPaths(classified);
      if (paths.length === 0) {
        return deny(
          'cannot verify the edit target is inside the worktree — use read_summary/report the path',
        );
      }
      const outside = paths.find((p) => !isPathInside(p, ctx.worktreePath));
      if (outside !== undefined) return deny(`edit target ${outside} is outside the worktree`);
      for (const p of paths) {
        const reason = gitDirWriteDenyReason(p, ctx);
        if (reason !== undefined) return deny(reason);
      }
      return ALLOW;
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
  'tree',
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
  if (treeWrites(tokens)) return false;
  if (REVIEWER_PLAIN_READ_ONLY_TOOLS.has(head)) return true;
  if (head === 'sed') return !isSedInPlace(tokens);
  if (head === 'find')
    // The engineer's `find` write-primitive set, so both roles deny the same.
    return !cmd.isFindWriteInvocation(tokens);
  // `perl -i` and `gawk -i inplace` fall through to `false`: neither is on
  // the allow-list (a regression test in `command.test.ts` locks that in).
  return false;
}

/** T343: `git diff -O<orderfile>` reads a file named on the command line. */
function readsGitOrderFile(tokens: string[]): boolean {
  return tokens.some((t) => t.startsWith('-O'));
}

function reviewerExecuteVerdict(command: string, ctx: PolicyContext): PolicyVerdict {
  // T457: a held Ask read is asked only once the whole command has passed.
  let held: PolicyVerdict | undefined;
  for (const atom of cmd.parseCommandIntoAtoms(command)) {
    if (cmd.runsUnderXargs(atom)) {
      return deny('reviewer role denies xargs: it runs a command on paths no check can see');
    }
    // Benign redirects write nothing (`git diff 2>/dev/null` is a read);
    // any other redirection or tee is a write primitive.
    if (cmd.hasWritingRedirectionOrTee(atom.tokens)) {
      return deny('reviewer role denies exec with redirection/tee — those are write primitives');
    }
    // T457: its reads keep to the read scope, as a coordinator's do (the
    // agile home and credentials were one `cat` away before).
    const reads = scopedReads(atom.tokens, ctx);
    if (isHeldRead(reads)) held ??= reads;
    else if (reads.action !== 'allow') return reads;
    // T343: git by T336's strict allowlist (no -c/--config-env, `GIT_*=` prefix,
    // pager, ext-diff, textconv, output), and no `-O<orderfile>`.
    if (cmd.isReadOnlyGitAtom(atom) && !readsGitOrderFile(atom.tokens)) continue;
    if (isReviewerSafeTool(atom.tokens)) continue;
    return deny(
      'reviewer role denies all exec except read-only tools (git diff/log/show, grep, …)',
    );
  }
  return held ?? ALLOW;
}

function reviewerVerdict(classified: PermissionRequest, ctx: PolicyContext): PolicyVerdict {
  switch (classified.toolClass) {
    case 'read':
      // Read-only tools (§14), within the read scope when there is one (T457).
      return hasReadScope(ctx) ? readPathsVerdict(allTargetPaths(classified), ctx) : ALLOW;
    case 'edit':
      return deny('reviewer role denies all writes — use read-only tools');
    case 'execute':
      if (classified.command === undefined) {
        return deny('reviewer role denies exec with no command to classify');
      }
      return reviewerExecuteVerdict(classified.command, ctx);
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
function coordinatorRedirectVerdict(
  tokens: string[],
  ctx: PolicyContext,
  cwd: string = ctx.worktreePath,
): PolicyVerdict {
  if (!cmd.hasWritingRedirectionOrTee(tokens)) return ALLOW;
  if (tokens.includes('tee') || tokens.some((t) => t.startsWith('<('))) {
    return deny('coordinator role denies tee/process substitution — write files with Write');
  }
  if (cmd.hasUnresolvedRedirection(tokens)) {
    return deny('coordinator role denies a redirect it cannot resolve');
  }
  for (const raw of cmd.redirectionTargets(tokens)) {
    const resolved = cmd.resolveTargetPath(raw);
    if (!resolved.safe || !isPathInside(resolve(cwd, resolved.path), ctx.worktreePath)) {
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
 * command must be readable (`readVerdict`); an unresolvable one denies.
 */
/**
 * T336 (review B4): the paths one argument may name. A flag carries its
 * value inside the token (`--orderfile=/x`, `-O/x`, `-O../x`), which must
 * be checked as the path, never the whole token read as a relative one.
 */
function pathCandidates(token: string): string[] {
  if (!token.startsWith('-') || token === '-' || token === '--') return [token];
  if (token.startsWith('--')) {
    const eq = token.indexOf('=');
    return eq === -1 ? [] : [token.slice(eq + 1)];
  }
  // A short option with its value attached (`-O/x`), or a bundle whose last
  // letter takes it (`-aO/x`): the value is the rest after the option letter,
  // or from where a path first starts.
  const start = token.slice(1).search(/[/.~]/);
  return start === -1 ? [token.slice(2)] : [token.slice(2), token.slice(start + 1)];
}

function scopedReads(
  tokens: string[],
  ctx: PolicyContext,
  cwd: string = ctx.worktreePath,
): PolicyVerdict {
  if (!hasReadScope(ctx)) return ALLOW;
  const paths: string[] = [];
  // T459: an input redirect's file (`cat <f`), whatever its spelling.
  for (const raw of cmd.inputRedirectTargets(tokens)) {
    const resolved = cmd.resolveTargetPath(raw);
    if (!resolved.safe) return deny(`coordinator role cannot resolve the path "${raw}"`);
    paths.push(resolve(cwd, resolved.path));
  }
  for (const raw of tokens.slice(1).flatMap(pathCandidates)) {
    if (!(raw.includes('/') || raw.startsWith('.') || raw.startsWith('~'))) continue;
    const resolved = cmd.resolveTargetPath(raw);
    if (!resolved.safe) return deny(`coordinator role cannot resolve the path "${raw}"`);
    // T336: relative to where a `cd` left the command.
    paths.push(resolve(cwd, resolved.path));
  }
  return readPathsVerdict(paths, ctx, { walks: walkMode(tokens) });
}

/**
 * T336: `cd <dir>` (Claude's `cd <repo> && git log`) moves where the atoms
 * after it run. The dir must be readable; a later relative redirect then
 * resolves from it. Returns the new cwd, or the deny.
 */
function coordinatorCd(
  tokens: string[],
  ctx: PolicyContext,
  cwd: string,
  hold: (verdict: PolicyVerdict) => void,
): { dir: string } | PolicyVerdict {
  const moved = cdTarget(tokens, cwd, 'coordinator');
  if ('action' in moved) return moved;
  if (hasReadScope(ctx)) {
    const verdict = readVerdict(moved.dir, ctx);
    // T457: a held Ask read keeps walking, so the atoms after the cd are still checked.
    if (verdict.action === 'hil' && isHeldRead(verdict)) hold(verdict);
    else if (verdict.action !== 'allow') return verdict;
  }
  return moved;
}

/** The reviewer's read-only tools, plus the two a scratch-dir redirect needs. */
const COORDINATOR_WRITE_TOOLS = new Set(['echo', 'printf']);

function coordinatorExecuteVerdict(command: string, ctx: PolicyContext): PolicyVerdict {
  // T457: a held Ask read is asked only once the whole command has passed.
  let held: PolicyVerdict | undefined;
  const hold = (verdict: PolicyVerdict) => {
    held ??= verdict;
  };
  const cd = (tokens: string[], cwd: string) => coordinatorCd(tokens, ctx, cwd, hold);
  for (const step of walkCwds(command, ctx.worktreePath, cd)) {
    if ('action' in step) return step;
    const { atom, cwds } = step;
    if (cmd.runsUnderXargs(atom)) {
      return deny('coordinator role denies xargs: it runs a command on paths no check can see');
    }
    for (const cwd of cwds) {
      const redirect = coordinatorRedirectVerdict(atom.tokens, ctx, cwd);
      if (redirect.action !== 'allow') return redirect;
      const reads = scopedReads(atom.tokens, ctx, cwd);
      if (isHeldRead(reads)) hold(reads);
      else if (reads.action !== 'allow') return reads;
    }
    // T336: git by the strict allowlist (no -c/--config-env, pager, ext-diff, ...).
    if (cmd.isReadOnlyGitAtom(atom)) continue;
    if (isReviewerSafeTool(atom.tokens)) continue;
    if (COORDINATOR_WRITE_TOOLS.has(atom.tokens[0] ?? '')) continue;
    return deny(
      'coordinator role denies exec except read-only tools and writes into its session dir',
    );
  }
  return held ?? ALLOW;
}

/** P20 (T280): reads as visibility allows, writes only inside the session dir, no network. */
function coordinatorVerdict(classified: PermissionRequest, ctx: PolicyContext): PolicyVerdict {
  switch (classified.toolClass) {
    case 'read': {
      if (!hasReadScope(ctx)) return ALLOW;
      return readPathsVerdict(allTargetPaths(classified), ctx);
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
      return reviewerVerdict(classified, ctx);
    case 'coordinator':
      return coordinatorVerdict(classified, ctx);
  }
}
