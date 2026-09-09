/**
 * The policy table (T010, design/agile-agents-design.md §14 "Permissions per
 * role"): one module holding the never-without-human list and each role's
 * allow rules, "so T014/T016 can extend them" (ticket "Tests" paragraph).
 *
 * Every verdict function returns a reason string on deny/hil (never a bare
 * `false`) — "Deny always carries a reason and a pointer" (§14).
 *
 * Review-round rewrite (opus's blocking findings + manager consolidation):
 * a command is now split into `CommandAtom`s (command.ts) — one per
 * `;`/`&&`/`||`/`|`/newline-separated segment, with `sh -c "..."` recursed
 * into — and classified **most-restrictive-atom-wins**: any atom that hits
 * the never-without-human list makes the whole command `hil`; failing that,
 * any atom the role table would deny makes the whole command `deny`; only
 * if every atom is individually allowed does the whole command allow. This
 * is what closes the `git status && git push origin main` /
 * `FOO=1 git push origin main` / `cd sub && git push origin main` /
 * `sh -c "git push origin main"` bypasses.
 */

// T017 review round: QA's `cat`/`head`/`grep` Bash rule (below,
// `qaBashPathVerdict`) reuses the exact same path-resolution/glob-matching
// primitives QA's raw-Read deny check uses, rather than re-deriving them —
// `import type` elsewhere in `qa/deny.ts` (of `PermissionRole`, from this
// package's `../permissions` barrel) makes this a type-only back-edge at
// the JS level, not a runtime circular require.
import { matchesAnyPattern, resolveRelToWorktree } from '../qa/deny';
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
  /** This ticket's id (`TKT-0001`) — the only branch a `push` may target without a human (opus should-fix 4). */
  ticket: string;
}

// ---------------------------------------------------------------------------
// Never-without-human (§14 "Never without a human"). Checked before any
// role table, for every role: nobody's allow-list can override these.
// ---------------------------------------------------------------------------

/**
 * A handful of well-known package registry hosts, for the engineer's
 * "package registries only" network allowance (§14). DESIGN-GAP: the design
 * names no exhaustive list; this is a starter set matching the ticket's
 * "package registries" language, extensible here rather than by relaxing
 * the check some other way.
 */
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
 * Every path a request needs containment-checked (round-4 review fix:
 * `classified.targetPath` alone is only the first of `toolCall.locations`
 * — a `[inside, outside]` pair must not pass just because the first entry
 * does). Falls back to `[targetPath]` for `rawInput`/title-derived
 * requests, which only ever carry one.
 */
function allTargetPaths(classified: PermissionRequest): string[] {
  if (classified.targetPaths !== undefined) return classified.targetPaths;
  return classified.targetPath !== undefined ? [classified.targetPath] : [];
}

/** The never-without-human verdict for one already-parsed atom, or `undefined` if this atom doesn't match any named category. */
function neverWithoutHumanForAtom(
  atom: cmd.CommandAtom,
  ctx: PolicyContext,
): PolicyVerdict | undefined {
  const { tokens } = atom;

  const parsedGit = cmd.parseGitInvocation(tokens);
  if (parsedGit.cPaths.some((p) => !isPathInside(p, ctx.worktreePath))) {
    return hil('git -C outside the worktree is never automatic — file a hil_request');
  }
  const args = parsedGit.args;
  if (args !== undefined) {
    if (cmd.isForcePush(args)) {
      return hil('force-push is never automatic — file a hil_request');
    }
    if (cmd.isBranchDelete(args)) {
      return hil('branch deletion is never automatic — file a hil_request');
    }
    if (cmd.isGitResetHard(args)) {
      return hil('git reset --hard is never automatic — file a hil_request');
    }
    if (args[0] === 'push') {
      const refspecs = cmd.pushRefspecs(args);
      if (refspecs.length === 0) {
        return hil(
          'push with no explicit branch (current branch/default remote) is never automatic — file a hil_request',
        );
      }
      for (const refspec of refspecs) {
        const branch = cmd.refspecDestBranch(refspec);
        if (!cmd.isTicketBranch(branch, ctx.ticket)) {
          return hil(
            `push to ${branch} (not this ticket's branch) is never automatic — file a hil_request`,
          );
        }
      }
    }
  }

  if (cmd.isNewDependencyInstall(tokens)) {
    return hil('installing a new dependency is never automatic — file a discovery/hil_request');
  }
  if (cmd.isRmMinusRf(tokens)) {
    const outside = cmd.rmTargets(tokens).some((t) => !isPathInside(t, ctx.worktreePath));
    if (outside) {
      return hil('rm -rf outside the worktree is never automatic — file a hil_request');
    }
  }
  if (cmd.isPipedIntoBareShell(atom)) {
    return hil('piping a remote fetch into a shell is never automatic — file a hil_request');
  }
  if (cmd.isSudo(tokens)) {
    return hil('sudo is never automatic — file a hil_request');
  }
  if (cmd.isChmodRecursive777(tokens)) {
    return hil('chmod -R 777 is never automatic — file a hil_request');
  }

  return undefined;
}

/**
 * Checks the request against the universal never-without-human list.
 * Returns a `hil` verdict when matched, `undefined` when the request isn't
 * one of these named categories (the caller falls through to the role
 * table). Splits `execute` commands into atoms first (see file header) so
 * a shell chain can't smuggle a never-without-human segment past a
 * whitespace-only tokenizer.
 */
export function checkNeverWithoutHuman(
  classified: PermissionRequest,
  ctx: PolicyContext,
): PolicyVerdict | undefined {
  if (classified.toolClass === 'edit') {
    // Every location, not just the first (round-4 review fix — see
    // `allTargetPaths`): a `[safe.txt, .agile/tickets/x.yaml]` pair must
    // still hit these gates.
    const paths = allTargetPaths(classified);
    if (paths.some((p) => cmd.touchesAgileState(p))) {
      return hil('direct writes to .agile/ are never automatic — file a hil_request');
    }
    if (paths.some((p) => cmd.isManifestPath(p))) {
      return hil(
        'editing a dependency manifest/lockfile is never automatic — file a discovery/hil_request',
      );
    }
  }

  if (classified.toolClass === 'execute' && classified.command !== undefined) {
    if (cmd.hasUnsafeShellConstruct(classified.command)) {
      return hil(
        'command substitution/backticks/eval/unbalanced quotes are unclassifiable — file a hil_request',
      );
    }
    for (const atom of cmd.parseCommandIntoAtoms(classified.command)) {
      const verdict = neverWithoutHumanForAtom(atom, ctx);
      if (verdict !== undefined) return verdict;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Role tables (§14's table, one function per role). Each assumes
// `checkNeverWithoutHuman` already ran and returned nothing.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Engineer benign-command table (T030): everyday commands the allow-list
// otherwise starves out because they're neither a repo script nor git.
// Checked only after `isRepoScriptCommand`/`gitArgs` have already had first
// claim (so `bun run`/`bun add`/any git subcommand keep their existing,
// more specific handling) and only for atoms that survived
// `checkNeverWithoutHuman` and the redirection gate above.
// ---------------------------------------------------------------------------

/** Commands with nothing worth containment-checking: they take no
 * filesystem path (`pwd`, `date`, `which`, `true`, `false`), or only ever
 * report existence/exit status rather than content (`test`, `[`), or print
 * their literal argv (`echo`, `printf`) or transform stdin (`tr`). */
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

/** Commands whose non-flag positional arguments are every path they read or write — see `cmd.benignPathArgs`. */
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

/**
 * Every path this atom touches must resolve inside the worktree, via
 * `cmd.resolveTargetPath` (T030 review findings 1 & 4): `~`/`~/rest` are
 * expanded against the real home directory first (never trusted as
 * "inside" just because the literal string is relative-looking); a `$`,
 * backtick, or unsupported `~user` form is unclassifiable and routes to
 * `hil` — never a guessed allow.
 */
function verifyBenignPaths(paths: string[], ctx: PolicyContext): PolicyVerdict {
  for (const raw of paths) {
    const resolved = cmd.resolveTargetPath(raw);
    if (!resolved.safe) {
      return hil(
        `"${raw}" contains an unresolved shell variable/backtick/home-directory reference — file a hil_request`,
      );
    }
    if (!isPathInside(resolved.path, ctx.worktreePath)) {
      return deny(`${raw} is outside the worktree`);
    }
  }
  return ALLOW;
}

/**
 * The benign-command verdict for one atom, or `undefined` if its head isn't
 * one of these named benign shapes at all (the caller falls through to the
 * existing "not an allowed command" deny).
 */
function engineerBenignCommandVerdict(
  atom: cmd.CommandAtom,
  ctx: PolicyContext,
): PolicyVerdict | undefined {
  const { tokens } = atom;
  const head = tokens[0];

  if (head === undefined) {
    // A bare wrapper invocation (`env`, `command`, `exec`, `nohup`, `time`,
    // `xargs`) with nothing left after `stripPrefixes` removed it — inert,
    // nothing to run. This is also how `env` with no assignments (ticket:
    // "env (no assignments)") reaches here: `env` is itself a wrapper
    // command (command.ts's `WRAPPER_COMMANDS`), so a bare `env` always
    // strips to an empty token list before any policy layer sees it.
    return ALLOW;
  }

  if (ENGINEER_BENIGN_NO_PATH_TOOLS.has(head)) return ALLOW;

  const dlx = cmd.parseDlxInvocation(tokens);
  if (dlx !== undefined) {
    // T030 QA round 2 / opus round 3: `bunx`/`bun x`/`npm exec` are allowed
    // only when the target bin actually exists (as a real, executable,
    // in-worktree file — see cmd.isRepoLocalBin) in this worktree's
    // node_modules/.bin at decision time — not a syntactic guess (a bare
    // `npx cowsay`/`bunx cowsay` with no repo dependency on cowsay must hil
    // as "new dependency execution", the same as `bun add cowsay` would).
    // A forced-install flag (-p/--package/-y/--yes/-g/--global) is always
    // hil, even if a same-named bin happens to exist, since it can
    // install/overwrite a different version than what's actually checked
    // in. `pnpm dlx`/`yarn dlx` never consult the local node_modules/.bin
    // at all — `dlx` always fetches into a temporary store and runs that —
    // so they're always hil regardless of `isRepoLocalBin`.
    if (dlx.forcesInstall) {
      return hil(
        `"${dlx.bin}" forces a package install/global run (-p/--package/-y/--yes/-g/--global) — file a hil_request`,
      );
    }
    if (dlx.neverLocal) {
      return hil(
        `"${dlx.bin}" via dlx always fetches into a temporary store, never the local node_modules/.bin — file a hil_request`,
      );
    }
    return cmd.isRepoLocalBin(dlx.bin, ctx.worktreePath)
      ? ALLOW
      : hil(
          `"${dlx.bin}" is not an existing repo-local bin (node_modules/.bin) — file a hil_request (new dependency execution)`,
        );
  }

  if (head === 'find') {
    if (cmd.isFindWriteInvocation(tokens)) return undefined; // -delete/-exec/-ok/-fprint*: not benign, fall through
    return verifyBenignPaths(cmd.findSearchRoots(tokens), ctx);
  }

  if (head === 'grep' || head === 'rg') {
    return verifyBenignPaths([...cmd.grepPathArgs(tokens), ...cmd.flagPathValues(tokens)], ctx);
  }

  const scriptPath = cmd.scriptExecutionPath(tokens);
  if (scriptPath !== undefined) {
    return verifyBenignPaths([scriptPath], ctx);
  }

  if (ENGINEER_BENIGN_PATH_TOOLS.has(head)) {
    return verifyBenignPaths([...cmd.benignPathArgs(tokens), ...cmd.flagPathValues(tokens)], ctx);
  }

  return undefined;
}

function engineerExecuteVerdict(command: string, ctx: PolicyContext): PolicyVerdict {
  for (const atom of cmd.parseCommandIntoAtoms(command)) {
    if (cmd.hasRedirectionOrTee(atom.tokens)) {
      // Every *non-benign* redirection target must resolve inside the
      // worktree (review round 2: a single `>` used to be the only spelling
      // checked — `1>`, `2>`, `&>`, and a second `>` later in the same atom
      // all slipped through). `tee`, an unresolvable target, and a process
      // substitution (`<(...)`) have no path to verify, so they deny
      // outright rather than guess. Benign targets (`/dev/null`, fd-dup
      // `&1`/`&2`, fd-close `&-`) are not writes and need no containment
      // check at all (T029: `npm test 2>&1`, `cmd 2>/dev/null`,
      // `cmd >/dev/null` no longer over-deny here).
      const hasTee = atom.tokens.includes('tee');
      const hasProcessSub = atom.tokens.some((t) => t.startsWith('<('));
      const unresolved = cmd.hasUnresolvedRedirection(atom.tokens);
      if (hasTee || hasProcessSub || unresolved) {
        return deny('redirected output escapes the worktree (or uses tee/process substitution)');
      }
      // Every redirection target goes through the same `~`/`$VAR`/backtick
      // resolution as any other path argument (T030 review finding 4 —
      // `echo hi > $HOME/.ssh/authorized_keys`/`echo hi > ~/.bashrc` must
      // not be laundered through a purely textual "starts with /" miss).
      for (const raw of cmd.redirectionTargets(atom.tokens)) {
        const resolved = cmd.resolveTargetPath(raw);
        if (!resolved.safe) {
          return hil(
            `"${raw}" contains an unresolved shell variable/backtick/home-directory reference — file a hil_request`,
          );
        }
        if (!isPathInside(resolved.path, ctx.worktreePath)) {
          return deny('redirected output escapes the worktree (or uses tee/process substitution)');
        }
      }
      // Every non-benign redirection target is inside the worktree (or
      // every redirection here was benign) — fall through and still
      // classify the underlying command below. A safe redirect target does
      // not by itself make the command it's attached to allowed (e.g.
      // `rm -rf secret > <worktree>/out.log` must still be denied for not
      // being a repo script or git invocation).
    }
    if (cmd.isRepoScriptCommand(atom.tokens)) continue;
    if (cmd.gitArgs(atom.tokens) !== undefined) {
      // Any git invocation inside the worktree that isn't on the
      // never-without-human list above (push/force-push/branch-delete/
      // reset --hard already handled) is the engineer's own ticket
      // branch work — "git inside the worktree except the never list" (ticket).
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
      // "own worktree; state via daemon" (§14) — reads are never gated by
      // ACP anyway (spike-findings §A), but answer consistently if asked.
      return ALLOW;
    case 'edit': {
      // Every path must resolve inside the worktree (round-4 review fix,
      // R4-1): a request with an inside path first and an outside one
      // second must not read as "verified" once the first one passes.
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
        // DESIGN-GAP (manager decision, overriding the reviewer's
        // suggested `hil`): a `hil` here would flood the human queue with
        // every generic "Terminal"-titled request a vendor sends without
        // rawInput — every exec this policy can't read a command for,
        // benign or not. `deny` is recoverable (the model gets a reason
        // and a pointer) and keeps the human queue for requests this
        // layer actually understands. Command-level enforcement for
        // exactly this "we can't see the command" case is T009's
        // PreToolUse hook's job (see index.ts's file header) — it
        // provably carries `tool_input.command` (spike-findings §B),
        // this tier does not.
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
/** T030: extended with the pure read-only subset of the engineer's new
 * benign-command table (`head`/`tail`/`diff`/`pwd`/`which`) — reading, never
 * writing, so safe for the reviewer's read-only-tools allowance (§14) too. */
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

/**
 * `sed`/`find` are only read-only in a subset of their invocations — `sed
 * -i` and `find … -delete`/`-exec` are write primitives (opus blocking
 * finding 2), so they're gated on flags rather than allowed/dropped
 * wholesale.
 */
/** `sed -i`/`-i.bak`/`-ibak` (short form, review round 1) and `--in-place`/`--in-place=.bak` (long form, review round 2 — `t.startsWith('-i')` alone never matched a `--`-prefixed flag) are all in-place-edit forms. */
function isSedInPlace(tokens: string[]): boolean {
  return tokens.some(
    (t) => t === '-i' || t.startsWith('-i') || t === '--in-place' || t.startsWith('--in-place='),
  );
}

function isReviewerSafeTool(tokens: string[]): boolean {
  const head = tokens[0];
  if (head === undefined) return false;
  if (REVIEWER_PLAIN_READ_ONLY_TOOLS.has(head)) return true;
  if (head === 'sed') return !isSedInPlace(tokens);
  if (head === 'find')
    // T030 review finding 2: reuse the engineer's write-flag set
    // (`-delete`/`-exec`/`-execdir`/`-ok`/`-okdir`/`-fprint`/`-fprintf`/
    // `-fls`) so the reviewer denies exactly the same `find` write
    // primitives, not a narrower list.
    return !cmd.isFindWriteInvocation(tokens);
  // `perl -i ...` and `gawk -i inplace ...` are also in-place rewrites
  // (review round 2, "if cheap") — neither `perl` nor `gawk`/`awk` is in
  // `REVIEWER_PLAIN_READ_ONLY_TOOLS` or has a case above, so they already
  // fall through to `false` (denied) regardless of flags. No extra check
  // is needed unless one of them is ever added to the allow-list — see
  // `command.test.ts` for a locked-in regression covering both.
  return false;
}

function reviewerExecuteVerdict(command: string): PolicyVerdict {
  for (const atom of cmd.parseCommandIntoAtoms(command)) {
    // Benign redirects (`/dev/null`, fd-dup/close) write nothing, so
    // `git diff 2>/dev/null` is a read like any other `git diff` (T029);
    // tee, process substitution, an unresolved target, or a real-file
    // target are still denied as write primitives.
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
      // "worktree via tools, rules, oracle" — read-only tools (§14).
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

function qaExecuteVerdict(command: string): PolicyVerdict {
  // "anything in the env" (§14) — exec is bounded by the QA env itself (a
  // throwaway clone/container, §13), not by a path check here. Redirection
  // and tee are still write primitives regardless of role (opus blocking
  // finding 2 names reviewer/QA together) — except benign forms
  // (`/dev/null`, fd-dup/close), which write nothing (T029).
  for (const atom of cmd.parseCommandIntoAtoms(command)) {
    if (cmd.hasWritingRedirectionOrTee(atom.tokens)) {
      return deny('QA role denies exec with redirection/tee — those are write primitives');
    }
  }
  return ALLOW;
}

/** Bash binaries that read a file's contents (or a directory's) given a path argument — the ones §14's QA Bash rule (review round fix) needs to gate the same way a raw `Read` is gated. Not exhaustive (no `less`/`more`/`awk`/`sed` without `-i` etc. — those already reach `qaExecuteVerdict`'s allow path unchanged); extend here if a real run shows another one QA reaches for. */
const QA_PATH_READING_BINARIES = new Set(['cat', 'head', 'tail', 'grep']);

function isFlagToken(token: string): boolean {
  return token.startsWith('-');
}

/**
 * QA round-2 review fix: `cat`/`head`/`tail`/`grep` reach a QA env's
 * `contract.inputs`/`outputs` just as readily as a raw `Read` — the Bash
 * execute path was never checked against the deny list at all (§14's QA
 * row: "env minus contract.inputs/outputs" was only ever enforced for
 * `Read`/`Grep`-the-tool, not `Bash cat`/`grep`/etc.).
 *
 * This is a STANDALONE function, not folded into `qaExecuteVerdict`'s
 * normal role-table walk: `decidePermission` (`permissions/decide.ts`, out
 * of this ticket's file ownership) builds `PolicyContext` as a fixed
 * `{role, worktreePath, ticket}` object with no room for a per-ticket deny
 * list, so a caller that HAS resolved one (today: `hook/decide.ts`'s
 * `roleToolVerdict`, from the ticket's own `contract.inputs/outputs` via
 * `qa/deny.ts`'s `qaReadDenyList`) calls this ADDITIONALLY — see
 * `hook/decide.ts` for the wiring. The ACP-responder tier
 * (`permissions/responder.ts`, also out of scope here) does not call this;
 * it inherits the same DESIGN-GAP `qaVerdict`'s own `read`/`execute` cases
 * already flag ("the contract-scoped exclusion is enforced by whatever
 * hands QA its tool permissions ... not by this generic ACP layer").
 *
 * `grep`'s first non-flag argument is its pattern, not a path — skipped.
 * Every other non-flag argument of a matched binary is resolved against
 * `worktreePath` (`qa/deny.ts`'s `resolveRelToWorktree`, the same resolver
 * the raw-Read check uses) and checked against `denyList` (`qa/deny.ts`'s
 * `matchesAnyPattern`).
 */
export function qaBashPathVerdict(
  command: string,
  worktreePath: string,
  denyList: readonly string[],
): PolicyVerdict | undefined {
  if (denyList.length === 0) return undefined;
  for (const atom of cmd.parseCommandIntoAtoms(command)) {
    const [head, ...rest] = atom.tokens;
    if (head === undefined || !QA_PATH_READING_BINARIES.has(head)) continue;
    const nonFlagArgs = rest.filter((t) => !isFlagToken(t));
    const pathArgs = head === 'grep' ? nonFlagArgs.slice(1) : nonFlagArgs;
    for (const arg of pathArgs) {
      const relPath = resolveRelToWorktree(arg, worktreePath);
      if (matchesAnyPattern(relPath, denyList)) {
        return deny('QA may not read contract inputs/outputs (§13)');
      }
    }
  }
  return undefined;
}

function qaVerdict(classified: PermissionRequest): PolicyVerdict {
  switch (classified.toolClass) {
    case 'read':
      // "env minus contract.inputs/outputs" (§14) — the contract-scoped
      // exclusion is enforced by whatever hands QA its tool permissions
      // (§13: "QA's tool permissions deny Read/grep on contract.outputs and
      // contract.inputs"), not by this generic ACP layer, which has no
      // contract in scope. DESIGN-GAP, flagged for T018/whoever wires QA's
      // tool-level permissions.
      return ALLOW;
    case 'edit':
      // "own test files in the env" (§14) vs "deny edits to source"
      // (ticket). Distinguishing a QA-owned test file from source needs
      // contract awareness this layer doesn't have — deny by default is
      // the safe reading of "deny edits to source". DESIGN-GAP, same as above.
      return deny('QA role denies edits to source — write test files only, via a dedicated tool');
    case 'execute':
      if (classified.command === undefined) return ALLOW;
      return qaExecuteVerdict(classified.command);
    case 'fetch':
      // "env base URL" (§14). No base URL is threaded into this policy
      // layer yet (DecisionContext has no envBaseUrl field) — treat as
      // outside the allowlist until one is, rather than allow blindly.
      return hil(
        'QA network access is scoped to the env base URL — file a hil_request until env base URL is wired in',
      );
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
    case 'qa':
      return qaVerdict(classified);
  }
}
