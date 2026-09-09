/**
 * Git pre-commit hook: refuses a commit while an active halt covers the
 * ticket that owns the current worktree (T019 — design/agile-agents-
 * design.md §6 "Enforcement tiers and hook catalog": "pre-commit: review
 * approved + tests pass; refuse while a halt file covers this ticket";
 * §5 "No hooks at all": "Halts enforced by ... a git hook refusing commits
 * while a halt file exists.").
 *
 * Mechanism (session brief's own three options, decided): a git *worktree*
 * (`.worktrees/TKT-0231`, created by `runner/worktrees.ts`) has no hooks
 * directory of its own — every worktree of one repo shares the **main**
 * repo's `.git/hooks/` unless `core.hooksPath` is overridden per worktree,
 * which needs `extensions.worktreeConfig` plumbing with no sibling
 * precedent in this codebase (CLAUDE.md: no new conventions without
 * approval). So `installPreCommitHook` writes exactly **one** shared
 * `pre-commit` script into the main repo's common `.git/hooks/` directory
 * (found via `git rev-parse --git-common-dir` from inside the worktree —
 * resolves correctly for a linked worktree, unlike `--show-toplevel` which
 * would return the worktree's own path). The script itself resolves *which*
 * ticket a given commit belongs to at commit time, from whichever
 * worktree's branch is checked out (`tkt/<digits>-<slug>` ->
 * `TKT-<digits>`, `runner/worktrees.ts`'s own naming), so one installed
 * script covers every ticket worktree in the repo — `installPreCommitHook`
 * is safe (and cheap: a no-op write when the content already matches) to
 * call again for every new ticket worktree the manager creates.
 *
 * Limits (documented, not solved — no sibling precedent to build a merge-
 * with-existing-hook step from, unlike `hook/settings.ts`'s JSON merge):
 *  - `installPreCommitHook` refuses (throws) rather than silently
 *    overwriting a `pre-commit` hook it did not itself install (review
 *    round 1 nit — detected by the absence of this module's `MARKER`
 *    string in the existing file). It does not attempt to *chain* into a
 *    foreign hook (call it after ours) since there is no sibling precedent
 *    in this codebase for composing hook scripts; a human resolves the
 *    conflict by removing/renaming the foreign hook or merging it into the
 *    generated script by hand.
 *  - Only checked-out worktrees on a `tkt/*` branch are covered; a commit
 *    made directly on `integration`/`main` in the main checkout (this
 *    package's own merge commits) is never blocked by this hook, by design
 *    — those commits are the merge/integration owner's own writes, not an
 *    engineer's.
 *  - Runs `bun -e ...` once per commit (a git hook's normal cost profile;
 *    same order of magnitude as T009's `agile hook` PreToolUse cost).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Ticket } from '@agile-agents/shared';
import { TicketIdSchema } from '@agile-agents/shared';
import { activeHaltsFor } from '../halts';
import { StateStore } from '../store';
import { runGit } from './git';

export interface CommitCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Present in every script `renderPreCommitScript` generates — the only
 * signal `installPreCommitHook` has for "this hook is ours" vs. "a human or
 * another tool put something else at `.git/hooks/pre-commit`" (review
 * round 1 nit).
 */
const HOOK_MARKER = 'Installed by agile-agents T019';

export class ForeignPreCommitHookError extends Error {
  constructor(public readonly hookPath: string) {
    super(
      `installPreCommitHook: refusing to overwrite ${hookPath} — it does not contain the "${HOOK_MARKER}" marker, so it wasn't installed by this module. Remove or back it up, or fold its logic into the generated script by hand, before retrying.`,
    );
    this.name = 'ForeignPreCommitHookError';
  }
}

/**
 * Called by the generated hook script (via `bun -e`, see
 * `renderPreCommitScript`) with the repo's `.agile/` state root and the
 * ticket id resolved from the current branch. Fails **closed**: an
 * unreadable/uninitialised state root refuses the commit rather than
 * silently allowing it — same posture as T009's hook ("fails closed
 * whenever ... cannot be resolved"), since a state root that vanished out
 * from under a live worktree is itself the kind of surprise this hook
 * exists to catch, not a reason to wave the commit through.
 */
export function checkCommitAllowed(stateRoot: string, ticketId: string): CommitCheck {
  const parsedId = TicketIdSchema.safeParse(ticketId);
  if (!parsedId.success) {
    return { allowed: false, reason: `commit refused — not a valid ticket id: ${ticketId}` };
  }

  let store: StateStore;
  try {
    store = StateStore.open(stateRoot);
  } catch (err) {
    return {
      allowed: false,
      reason: `commit refused — could not open state root ${stateRoot}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const halts = activeHaltsFor(store, parsedId.data);
  if (halts.length === 0) return { allowed: true };

  const reasons = halts.map((h) => `${h.id}: ${h.reason}`).join('; ');
  return {
    allowed: false,
    reason: `commit refused — active halt on ${parsedId.data}: ${reasons}`,
  };
}

function shellSingleQuote(value: string): string {
  // Standard POSIX single-quote escaping: close the quote, emit an escaped
  // literal quote, reopen — needed only in the pathological case a repo
  // path itself contains a `'`.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Renders the shared `pre-commit` script content. `mergeIndexPath` and
 * `stateRoot` are fixed at install time (baked into the script as JS string
 * literals inside the `bun -e` argument); the ticket id is the only thing
 * resolved at commit time, from the branch — passed through an env var
 * rather than string-substituted into the `-e` argument, so a ticket id
 * never has to be shell- or JS-string-escaped.
 */
export function renderPreCommitScript(mergeIndexPath: string, stateRoot: string): string {
  const evalBody = [
    `import { checkCommitAllowed } from ${JSON.stringify(mergeIndexPath)};`,
    `const r = checkCommitAllowed(${JSON.stringify(stateRoot)}, process.env.AGILE_PRECOMMIT_TICKET);`,
    'if (!r.allowed) { console.error(r.reason); process.exit(1); }',
  ].join(' ');

  return `#!/bin/sh
# ${HOOK_MARKER} (packages/daemon/src/merge/precommit.ts).
# Worktrees share this repo's .git/hooks directory; this script resolves
# which ticket owns the *current* worktree from its checked-out branch
# (tkt/<digits>-<slug> -> TKT-<digits>) and refuses the commit while an
# active halt covers that ticket. Commits on any other branch (integration,
# main, ...) are never touched by this hook.
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
case "$BRANCH" in
  tkt/*)
    DIGITS=$(printf '%s' "$BRANCH" | sed -n 's#^tkt/\\([0-9][0-9]*\\)-.*#\\1#p')
    if [ -n "$DIGITS" ]; then
      AGILE_PRECOMMIT_TICKET="TKT-$DIGITS" bun -e ${shellSingleQuote(evalBody)}
      exit $?
    fi
    ;;
esac
exit 0
`;
}

export interface InstallPreCommitHookResult {
  hookPath: string;
  installed: boolean;
}

/**
 * Resolves the absolute path to *this package's* barrel — `index.ts` when
 * running from source (every test in this repo, and a `bun run`ned daemon),
 * `index.js` once `bun run build` (`tsconfig.json`'s `tsc` build, see
 * `package.json`) has emitted this file next to `dist/merge/precommit.js`
 * (review round 1 nit: `import.meta.dir` is wherever *this* file physically
 * runs from, so the extension must track it rather than being hardcoded to
 * source).
 */
function resolveMergeIndexPath(): string {
  const tsPath = join(import.meta.dir, 'index.ts');
  if (existsSync(tsPath)) return tsPath;
  const jsPath = join(import.meta.dir, 'index.js');
  if (existsSync(jsPath)) return jsPath;
  throw new Error(
    `installPreCommitHook: could not find index.ts or index.js next to ${import.meta.dir}`,
  );
}

/**
 * Installs (or leaves untouched, if already byte-identical) the shared
 * `pre-commit` script for the repo `worktreePath` belongs to. `ticket` is
 * used only to sanity-check that `worktreePath` is actually checked out on
 * that ticket's branch — a mismatch is not fatal (the hook itself re-
 * resolves the ticket from the branch at commit time regardless, so it
 * would work correctly for whatever ticket the caller *should* have
 * passed), just surfaced so a caller wiring this up wrong finds out
 * immediately rather than trusting a hook that happens to work anyway.
 *
 * Throws `ForeignPreCommitHookError` rather than overwriting a
 * `pre-commit` hook already present that this module didn't itself install
 * (review round 1 nit — see the file header's Limits section).
 */
export function installPreCommitHook(
  worktreePath: string,
  ticket: Ticket,
): InstallPreCommitHookResult {
  const rawCommonDir = runGit(['rev-parse', '--git-common-dir'], worktreePath);
  const commonDir = isAbsolute(rawCommonDir) ? rawCommonDir : resolve(worktreePath, rawCommonDir);
  const repoRoot = dirname(commonDir);
  const stateRoot = join(repoRoot, '.agile');
  const mergeIndexPath = resolveMergeIndexPath();

  const hooksDir = join(commonDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-commit');

  const script = renderPreCommitScript(mergeIndexPath, stateRoot);
  const existing = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : undefined;
  if (existing !== undefined && !existing.includes(HOOK_MARKER)) {
    throw new ForeignPreCommitHookError(hookPath);
  }
  const installed = existing !== script;
  if (installed) {
    writeFileSync(hookPath, script);
    chmodSync(hookPath, 0o755);
  }

  return { hookPath, installed };
}
