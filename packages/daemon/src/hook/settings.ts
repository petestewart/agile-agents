/**
 * Per-worktree `.claude/settings.json` (agile-agents-design §6 tier 1;
 * spike-findings.md §B): `PreToolUse`, `PostToolUse` and `Stop` each run
 * `<agileBin> hook <event>` with matcher `"*"` (every tool, Read/Grep
 * included).
 *
 * `timeout` is Claude's per-invocation ceiling in seconds and must exceed
 * the CLI's 2000 ms RPC deadline: at equal values Claude could kill the
 * hook just as it printed its fail-closed deny. Default 5 s.
 *
 * `socketPath` is prefixed as `AGILE_SOCKET_PATH=…` (which
 * `discoverConfig` reads first): a worktree cwd would otherwise resolve
 * the wrong root. The calling session is resolved daemon-side from `cwd`
 * plus the `AGILE_AGENT` hint in the session env; the file carries no id,
 * since a worker and its reviewer share one worktree.
 *
 * Nothing lands in the user's repo (D24, P4): the file is git-excluded
 * via `info/exclude`. When the repo tracks its own `.claude/settings.json`
 * the hooks go into `.claude/settings.local.json` instead, which the
 * pinned adapter (`claude-agent-acp@0.81.1`) loads: its default
 * `settingSources` is `["user", "project", "local"]`, and Claude merges
 * hook arrays across sources. The adapter's other lever
 * (`_meta.claudeCode.options.settings`) would need a session-meta change.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sandboxedSubprocessEnv } from '../subprocess-env';

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
  /** Anything else already in the file: merged, not clobbered. */
  [key: string]: unknown;
}

export interface RenderClaudeSettingsOptions {
  /** The `agile` CLI (path, or name on `$PATH`). */
  agileBin: string;
  /** Prefixed as `AGILE_SOCKET_PATH=<socketPath> ` onto every hook command. */
  socketPath?: string;
  /** Claude's per-invocation timeout in seconds. Default 5, above the CLI's 2000 ms deadline. */
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
  ].filter((a): a is string => a !== undefined);
  const envPrefix = envAssignments.length > 0 ? `${envAssignments.join(' ')} ` : '';
  const command = `${envPrefix}${options.agileBin} hook ${agileEvent}`;
  // A hook that can't run exits non-zero with no stdout, which Claude
  // treats as non-blocking (a missing `agile` once disabled tier 1). Exit 2
  // is Claude's block code, so a PreToolUse hook that can't run denies. The
  // CLI itself prints a deny and exits 0 on an RPC failure.
  return agileEvent === 'pre-tool-use' ? `${command} || exit 2` : command;
}

/** The `.claude/settings.json` object this worktree needs. */
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
 * Merges into any existing `.claude/settings.json`: other top-level keys
 * and other hook events are preserved, this module's three events are
 * replaced (idempotent, byte-identical on repeat).
 */
export function writeClaudeSettings(
  worktreePath: string,
  options: RenderClaudeSettingsOptions,
): ClaudeSettings {
  const dir = join(worktreePath, '.claude');
  const path = join(dir, settingsFileName(worktreePath));
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
  excludeFromGit(worktreePath, '.claude/');
  return merged;
}

/** True when git tracks `rel` in `worktreePath`. Not a git repo: false. */
function isTracked(worktreePath: string, rel: string): boolean {
  const result = Bun.spawnSync(['git', 'ls-files', '--error-unmatch', '--', rel], {
    cwd: worktreePath,
    env: sandboxedSubprocessEnv(worktreePath, 'git'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0;
}

/**
 * `settings.json`, or `settings.local.json` when the repo tracks its own
 * `settings.json` (never overwritten). Both tracked: refused, since any
 * write would change a file the user owns.
 */
export function settingsFileName(worktreePath: string): 'settings.json' | 'settings.local.json' {
  if (!isTracked(worktreePath, '.claude/settings.json')) return 'settings.json';
  if (!isTracked(worktreePath, '.claude/settings.local.json')) return 'settings.local.json';
  throw new Error(
    `${worktreePath} tracks both .claude/settings.json and .claude/settings.local.json; the hook settings would change a tracked file`,
  );
}

/**
 * Adds `pattern` to the repo's `info/exclude` so git ignores the hook
 * config: untracked, a `git stash push -u` once took it and the hook
 * stopped running. Best effort: not a git repo, no change.
 */
function excludeFromGit(worktreePath: string, pattern: string): void {
  const result = Bun.spawnSync(['git', 'rev-parse', '--git-path', 'info/exclude'], {
    cwd: worktreePath,
    env: sandboxedSubprocessEnv(worktreePath, 'git'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) return;
  const rel = new TextDecoder().decode(result.stdout).trim();
  if (!rel) return;
  const excludePath = resolve(worktreePath, rel);
  const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  if (current.split('\n').some((line) => line.trim() === pattern)) return;
  mkdirSync(join(excludePath, '..'), { recursive: true });
  const sep = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  writeFileSync(excludePath, `${current}${sep}${pattern}\n`);
}
