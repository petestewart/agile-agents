/**
 * Per-worktree `.claude/settings.json` generation (T009 — design/
 * agile-agents-design.md §6 "Enforcement tiers and hook catalog" tier 1:
 * "vendor pre-tool-use hook in the worktree (`.claude/settings.json`)
 * calling `agile hook`"; wire shape verified against
 * `spike/permission-matrix.ts:125` and `design/spike-findings.md` §B).
 *
 * Settings shape: `{"hooks": {"PreToolUse": [{"matcher": "*", "hooks":
 * [{"type": "command", "command": "<agileBin> hook pre-tool-use",
 * "timeout": 2}]}], "PostToolUse": [...], "Stop": [...]}}` — one entry per
 * event, matcher `"*"` (every tool; the spike fixture used `""`, but
 * Claude Code's own hooks reference documents `"*"` as the canonical
 * match-everything matcher, and PreToolUse must fire for Read/Grep too, so
 * an event-scoped matcher — not a per-tool one — is what this ticket needs).
 * `timeout` is Claude's own per-hook-invocation ceiling in seconds (not to
 * be confused with `agile hook`'s own `--timeout` in milliseconds, T009's
 * CLI change, which stays 2000ms). Review round fix: it must EXCEED the
 * CLI's own RPC deadline, not equal it — at 2s/2000ms, Claude could kill
 * the hook process at the exact moment `agile hook` was about to print its
 * fail-closed deny JSON, turning a "daemon slow" case into a raw process
 * kill with nothing on stdout (worse than the deny it was designed to
 * produce). Default is 5s here so a slow daemon always yields a printed
 * deny before Claude's own timeout would fire.
 *
 * Agent identification (DESIGN-GAP, documented per the session brief's
 * "the daemon must know which agent is calling"): the brief's suggested
 * `--agent <id> --ticket <id>` CLI flags are NOT baked into the command
 * here. `packages/cli/src/commands/hook.ts` is out of this ticket's file
 * ownership except for the fail-closed/timeout/passthrough change, so this
 * module cannot add flag parsing for them without touching a file outside
 * `src/hook/`. Instead, `HookService` (`service.ts`) resolves the calling
 * agent/ticket daemon-side from the raw hook payload's `cwd` field (present
 * on every Claude hook event) against `Ticket.worktree` — a path already in
 * the shared schema, requiring no new field and no CLI change. If a future
 * ticket needs multiple agents to share one physical worktree (this design
 * doesn't), the `--agent`/`--ticket` flags remain the documented escape
 * hatch to add then.
 *
 * `socketPath`, when the worktree's own `git rev-parse --show-toplevel`
 * would not already resolve back to the main repo (true for every ticket
 * worktree under `.worktrees/`), is passed via `AGILE_SOCKET_PATH` — an env
 * assignment prefixed onto the command string, not a CLI flag — because
 * `discoverConfig`'s own precedence already reads that env var ahead of
 * config-file/default (`packages/daemon/src/config.ts`), so no CLI change
 * is needed for this either.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ClaudeHookEventName = 'PreToolUse' | 'PostToolUse' | 'Stop';

export interface ClaudeHookEntry {
  type: 'command';
  command: string;
  timeout: number;
}

export interface ClaudeHookMatcher {
  matcher: string;
  hooks: ClaudeHookEntry[];
}

export interface ClaudeSettings {
  hooks: Record<ClaudeHookEventName, ClaudeHookMatcher[]>;
  /** Anything else already in the file — `writeClaudeSettings` merges without clobbering these. */
  [key: string]: unknown;
}

export interface RenderClaudeSettingsOptions {
  /** Path (or bare name, if on `$PATH`) to the `agile` CLI binary the hook command invokes. */
  agileBin: string;
  /** When set, prefixed as `AGILE_SOCKET_PATH=<socketPath> ` onto every hook command — see file header. */
  socketPath?: string;
  /**
   * T012 QA/review round: when set, prefixed as `AGILE_AGENT=<agentId> `
   * onto every hook command (alongside `AGILE_SOCKET_PATH`, when both are
   * given). The CLI (`agile hook <event>`) forwards this env var as the
   * payload's `agile_agent` field; `hook/service.ts`'s `HookService`
   * resolves it as a disambiguation hint when more than one registered
   * agent's worktree contains the hook's `cwd` — the reviewer/engineer
   * shared-worktree case (§12, CLAUDE.md v0 default). Without it, that case
   * fails closed rather than guessing which agent is really calling.
   */
  agentId?: string;
  /** Claude's own per-hook-invocation timeout, in seconds. Default 5 — must exceed the CLI's 2000ms RPC deadline (`DEFAULT_HOOK_TIMEOUT_MS`) so a slow daemon always yields a printed fail-closed deny instead of a killed hook process. */
  timeoutSeconds?: number;
}

const HOOK_EVENTS: ReadonlyArray<{ claudeEvent: ClaudeHookEventName; agileEvent: string }> = [
  { claudeEvent: 'PreToolUse', agileEvent: 'pre-tool-use' },
  { claudeEvent: 'PostToolUse', agileEvent: 'post-tool-use' },
  { claudeEvent: 'Stop', agileEvent: 'stop' },
];

function hookCommand(options: RenderClaudeSettingsOptions, agileEvent: string): string {
  const envAssignments = [
    options.socketPath ? `AGILE_SOCKET_PATH=${options.socketPath}` : undefined,
    options.agentId ? `AGILE_AGENT=${options.agentId}` : undefined,
  ].filter((a): a is string => a !== undefined);
  const envPrefix = envAssignments.length > 0 ? `${envAssignments.join(' ')} ` : '';
  const command = `${envPrefix}${options.agileBin} hook ${agileEvent}`;
  // A hook whose binary is missing or crashes exits non-zero with nothing on
  // stdout, and Claude treats any exit code other than 2 as a *non-blocking*
  // error — the tool call proceeds ungated (first live run: no `agile` on
  // $PATH silently disabled tier 1). Exit 2 is Claude's "block" code, so a
  // PreToolUse hook that cannot even run now denies instead of allowing.
  // `agile hook pre-tool-use` itself still prints its own deny JSON and
  // exits 0 on an RPC failure, so this only fires when the CLI never ran.
  return agileEvent === 'pre-tool-use' ? `${command} || exit 2` : command;
}

/** Builds the `.claude/settings.json` object this worktree needs — `PreToolUse`/`PostToolUse`/`Stop`, each invoking `agile hook <event>` with matcher `"*"`. */
export function renderClaudeSettings(options: RenderClaudeSettingsOptions): ClaudeSettings {
  const timeout = options.timeoutSeconds ?? 5;
  const hooks = {} as Record<ClaudeHookEventName, ClaudeHookMatcher[]>;
  for (const { claudeEvent, agileEvent } of HOOK_EVENTS) {
    hooks[claudeEvent] = [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: hookCommand(options, agileEvent), timeout }],
      },
    ];
  }
  return { hooks };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merges `rendered` into whatever `.claude/settings.json` already exists at
 * `worktreePath`, without clobbering unrelated top-level keys (e.g. a
 * vendor-set `permissions` block) or other hook events this module doesn't
 * own. Within `hooks`, this module's three event keys
 * (`PreToolUse`/`PostToolUse`/`Stop`) are replaced wholesale (idempotent:
 * calling this twice with the same inputs is a no-op write, byte-identical
 * — see `settings.test.ts`); any other event key already present (a human
 * or another tool's hook config) is preserved untouched.
 */
export function writeClaudeSettings(
  worktreePath: string,
  options: RenderClaudeSettingsOptions,
): ClaudeSettings {
  const dir = join(worktreePath, '.claude');
  const path = join(dir, 'settings.json');
  mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (isPlainObject(parsed)) existing = parsed;
  }

  const existingHooks = isPlainObject(existing.hooks) ? existing.hooks : {};
  const rendered = renderClaudeSettings(options);
  const merged: ClaudeSettings = {
    ...existing,
    hooks: { ...existingHooks, ...rendered.hooks } as ClaudeSettings['hooks'],
  };

  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
