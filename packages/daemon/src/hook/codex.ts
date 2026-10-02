/**
 * T506: Codex's own `PreToolUse` hook, the same tier-1 gate as Claude's
 * (`settings.ts`), measured in design/spike-findings.md §C5 round 3:
 *
 * - Codex reads project hooks from `<project>/.codex/hooks.json`
 *   (`{hooks: {PreToolUse: [{matcher, hooks: [{type: 'command', command,
 *   statusMessage}]}]}}`), also under codex-acp (`codex app-server`).
 * - The hook gets `session_id, turn_id, transcript_path, cwd,
 *   hook_event_name, model, permission_mode, tool_name, tool_input,
 *   tool_use_id` on stdin; a shell command is `tool_name: 'Bash'` with
 *   `tool_input.command`. Exit 2 with a reason on stderr blocks the call
 *   (the model sees "Command blocked by PreToolUse hook: <reason>"); any
 *   other non-zero exit is a hook failure and the call runs anyway, so the
 *   script ends `|| exit 2`.
 * - Edits are `apply_patch` (a `Bash` matcher never sees them). Its
 *   `tool_input` was not measured: Codex's docs put the patch text in
 *   `tool_input.command`; `codexToClaudePayload` reads that and the other
 *   likely places, and an edit whose paths it can't find goes to the
 *   decision with no path, which every role table denies (as a Claude
 *   `Edit` with no `file_path` is).
 * - Project hooks load only in a trusted Codex project, trusted by path in
 *   `$CODEX_HOME/config.toml` (default `~/.codex`), an ancestor covering
 *   its descendants. The daemon never writes that file (Pete, 2026-10-02,
 *   option b): it reads it (`codexTrustFor`) and refuses a start the hook
 *   would not run in. An untrusted hook is skipped silently, so the runner
 *   also watches for tool calls the hook never saw (`CodexGateWatch`).
 *
 * - T511 (§C5 round 4): for a git worktree Codex loads project hooks from
 *   the main repo, not the worktree: a hook in the worktree's `.codex/` saw
 *   0 calls, the same hook at `<repo>/.codex/` saw 9. So a node in a
 *   worktree gets its hook at `<repo>/.codex/` (`codexHookPlacement`), and
 *   the script passes `--repo <repo>`: the CLI gates only calls whose `cwd`
 *   is under `<repo>/.worktrees/`, so the operator's own Codex in that repo
 *   runs as before. The worktree gets no copy. A session with no worktree
 *   (the Director, a node with no repo) keeps T506's hook in its own `cwd`.
 *
 * The command is a small script beside `hooks.json` rather than a shell
 * string: the spike measured Codex running an executable by its path, not
 * how it runs a command line. The script carries no session id (a worker
 * and its reviewer share one worktree, and every Codex node of a repo
 * shares the repo's file); the session env's `AGILE_AGENT` is the hint, as
 * for Claude.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { shellQuote } from '../runner/cli-bin';
import { atomicWriteFile } from '../store/fs';
import { excludeFromGit, isTracked } from './settings';
import type { ClaudePreToolUsePayload } from './types';

/** The Codex project layer the daemon writes into. */
export const CODEX_DIR = '.codex';
export const CODEX_HOOKS_FILE = 'hooks.json';
/** The executable the hook entries run. */
export const CODEX_GATE_SCRIPT = 'agile-pre-tool-use.sh';

/**
 * The tools gated, as Codex's regex matchers: shell (`Bash`, also how Codex
 * runs its own reads and searches), edits (`apply_patch`, which Codex's
 * docs say `Edit` and `Write` also match) and MCP tools (Claude's `*`
 * matcher covers them too).
 */
export const CODEX_HOOK_MATCHERS: readonly string[] = ['Bash', 'apply_patch|Edit|Write', 'mcp__.*'];

const STATUS_MESSAGE = 'agile gate';

export interface CodexHookEntry {
  type: 'command';
  command: string;
  statusMessage: string;
}

export interface CodexHookMatcher {
  matcher: string;
  hooks: CodexHookEntry[];
}

/** The gate's own `hooks.json` content. */
export interface CodexGateHooks {
  hooks: { PreToolUse: CodexHookMatcher[] };
}

/** The file as written: ours merged with whatever else was there (other matchers and events kept as found). */
export interface CodexHooksFile {
  hooks: { PreToolUse: unknown[]; [event: string]: unknown };
  [key: string]: unknown;
}

export interface CodexHookOptions {
  /** The `agile` CLI as a shell prefix (`cliInvocationToShell`). */
  agileBin: string;
  /** Set as `AGILE_SOCKET_PATH` for the CLI, as Claude's hook command does. */
  socketPath?: string;
  /**
   * T511: the repo root the hook sits at, passed to the CLI as `--repo`: only
   * calls from under `<repoRoot>/.worktrees/` are gated. Absent (a session
   * with no worktree): every call through the file is gated, as in T506.
   */
  repoRoot?: string;
}

/** The script every matcher runs: the CLI in Codex's mode, and exit 2 if it can't run. */
export function renderCodexGateScript(options: CodexHookOptions): string {
  const env = options.socketPath ? `AGILE_SOCKET_PATH=${shellQuote(options.socketPath)} ` : '';
  const repo = options.repoRoot !== undefined ? ` --repo ${shellQuote(options.repoRoot)}` : '';
  return [
    '#!/bin/sh',
    '# agile-agents: the Codex PreToolUse gate (T506, T511). Written by the daemon on every Codex start; edits are overwritten.',
    '# Exit 2 blocks the call; any other failure would let it run, so a CLI that cannot run blocks.',
    `${env}${options.agileBin} hook pre-tool-use --vendor codex${repo} || exit 2`,
    '',
  ].join('\n');
}

/** The `hooks.json` entries for a script at `scriptPath`. */
export function renderCodexHooks(scriptPath: string): CodexGateHooks {
  return {
    hooks: {
      PreToolUse: CODEX_HOOK_MATCHERS.map((matcher) => ({
        matcher,
        hooks: [{ type: 'command', command: scriptPath, statusMessage: STATUS_MESSAGE }],
      })),
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when a hook entry is one of ours: it runs a gate script by its file name. */
function isOurHook(entry: unknown): boolean {
  if (!isPlainObject(entry) || typeof entry.command !== 'string') return false;
  const command = entry.command;
  return command === CODEX_GATE_SCRIPT || command.endsWith(`${sep}${CODEX_GATE_SCRIPT}`);
}

/**
 * The file's `PreToolUse` with ours in it: every matcher of someone else's
 * kept as it is (ours taken out of it; a matcher left with none of its own
 * hooks dropped), then ours appended. Repeating it gives the same list.
 */
function mergePreToolUse(existing: unknown, ours: CodexHookMatcher[]): unknown[] {
  const kept: unknown[] = [];
  for (const matcher of Array.isArray(existing) ? existing : []) {
    if (!isPlainObject(matcher) || !Array.isArray(matcher.hooks)) {
      kept.push(matcher);
      continue;
    }
    const theirs = matcher.hooks.filter((entry) => !isOurHook(entry));
    if (theirs.length === matcher.hooks.length) kept.push(matcher);
    else if (theirs.length > 0) kept.push({ ...matcher, hooks: theirs });
  }
  return [...kept, ...ours];
}

/** Writes `content` unless the file already holds it; a write is a rename, so a reader never sees half a file. */
function writeIfChanged(path: string, content: string, mode?: number): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) {
    if (mode !== undefined) chmodSync(path, mode);
    return;
  }
  atomicWriteFile(path, content, mode);
}

/**
 * Writes `<root>/.codex/agile-pre-tool-use.sh` and merges the gate into
 * `<root>/.codex/hooks.json` (other keys, events and someone else's
 * `PreToolUse` matchers kept; ours replaced; byte-identical on repeat), and
 * git-excludes `.codex/` as Claude's `.claude/` is (`info/exclude` lives in
 * the common git dir, so a worktree's is the repo's). A repo that tracks
 * either file is refused: the write would change a file the user owns.
 *
 * T511: `root` is the repo root for a node in a worktree (`options.repoRoot`
 * set), shared by every Codex node of that repo: they all write the same
 * bytes, an unchanged file is not rewritten, and a changed one is replaced
 * by a rename (a Codex reading it, or running the script, never sees half a
 * file). The daemon is one process and this is synchronous, so two starts
 * never interleave.
 */
export function writeCodexHooks(root: string, options: CodexHookOptions): CodexHooksFile {
  for (const file of [CODEX_HOOKS_FILE, CODEX_GATE_SCRIPT]) {
    if (isTracked(root, `${CODEX_DIR}/${file}`)) {
      throw new Error(
        `${root} tracks ${CODEX_DIR}/${file}; Codex's gate would change a tracked file (untrack it, or move your hooks to ~/.codex/hooks.json)`,
      );
    }
  }
  const dir = join(root, CODEX_DIR);
  const script = join(dir, CODEX_GATE_SCRIPT);
  const path = join(dir, CODEX_HOOKS_FILE);
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // Never overwritten: it may hold the operator's own hooks.
      throw new Error(`${path} isn't valid JSON; Codex's gate can't be merged into it`);
    }
    if (isPlainObject(parsed)) existing = parsed;
  }
  const existingHooks = isPlainObject(existing.hooks) ? existing.hooks : {};
  const merged: CodexHooksFile = {
    ...existing,
    hooks: {
      ...existingHooks,
      PreToolUse: mergePreToolUse(
        existingHooks.PreToolUse,
        renderCodexHooks(script).hooks.PreToolUse,
      ),
    },
  };
  mkdirSync(dir, { recursive: true });
  writeIfChanged(script, renderCodexGateScript(options), 0o755);
  writeIfChanged(path, `${JSON.stringify(merged, null, 2)}\n`);
  excludeFromGit(root, `${CODEX_DIR}/`);
  return merged;
}

/** Where a Codex session's hook goes, and whether the CLI is told the repo (`--repo`). */
export interface CodexHookPlacement {
  /** The directory `.codex/` is written in, and whose trust is checked. */
  root: string;
  /** Set when `root` is a repo the session's worktree belongs to. */
  repoRoot?: string;
}

/**
 * T511: a session in a worktree of `repoRoot` gets its hook at the repo
 * root (Codex reads a worktree's project hooks from its main repo, §C5
 * round 4); any other session at its own `cwd`. The CLI's `--repo` guard
 * gates only calls from under `<repoRoot>/.worktrees/`, so a worktree
 * anywhere else would run ungated: refused.
 */
export function codexHookPlacement(cwd: string, repoRoot?: string): CodexHookPlacement {
  if (repoRoot === undefined) return { root: cwd };
  const root = resolve(repoRoot);
  const worktrees = join(root, '.worktrees');
  const inside = [resolve(cwd), realOr(cwd)].some((form) =>
    [worktrees, realOr(worktrees)].some((base) => form !== base && within(form, base)),
  );
  if (!inside) {
    throw new Error(
      `Codex's gate can't cover ${cwd}: it isn't a worktree under ${worktrees}, the only place the gate in ${root}/${CODEX_DIR} checks`,
    );
  }
  return { root, repoRoot: root };
}

// Trust (option b): read, never written.

/** Codex's home: `$CODEX_HOME` when set, else `~/.codex`. */
export function codexHomeDir(env: Record<string, string | undefined> = process.env): string {
  const set = env.CODEX_HOME?.trim();
  return set ? set : join(homedir(), '.codex');
}

export type CodexTrust = { trusted: true; by: string } | { trusted: false; why: string };

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** `path` is `root` or under it, comparing strings only. */
function within(path: string, root: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Whether Codex trusts `path`: the nearest `[projects."<dir>"]` at or above
 * it decides, and only `trust_level = "trusted"` counts. Both sides are
 * compared as given and `realpath`d (macOS `/var` is `/private/var`). A
 * missing, unreadable or malformed config is not trusted. The config's
 * contents are never logged or returned.
 */
export function codexTrustFor(path: string, codexHome: string = codexHomeDir()): CodexTrust {
  const configPath = join(codexHome, 'config.toml');
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    return { trusted: false, why: `no readable Codex config at ${configPath}` };
  }
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    return { trusted: false, why: `${configPath} isn't valid TOML` };
  }
  const projects = isPlainObject(parsed) ? parsed.projects : undefined;
  const forms = [...new Set([resolve(path), realOr(path)])];
  let best: { key: string; depth: number; level: unknown } | undefined;
  if (isPlainObject(projects)) {
    for (const [key, entry] of Object.entries(projects)) {
      if (!isAbsolute(key) || !isPlainObject(entry)) continue;
      const roots = [...new Set([resolve(key), realOr(key)])];
      const covers = forms.some((form) => roots.some((root) => within(form, root)));
      if (!covers) continue;
      const depth = resolve(key).split(sep).length;
      if (best === undefined || depth > best.depth) {
        best = { key, depth, level: entry.trust_level };
      }
    }
  }
  if (best?.level === 'trusted') return { trusted: true, by: best.key };
  return {
    trusted: false,
    why:
      best === undefined
        ? 'no trusted Codex project covers it'
        : `Codex project ${best.key} is not trusted`,
  };
}

/** The repo a worktree belongs to (`<repo>/.worktrees/<id>-<slug>`), else the path itself. */
export function codexTrustTarget(worktreePath: string): string {
  const marker = `${sep}.worktrees${sep}`;
  const at = worktreePath.lastIndexOf(marker);
  return at > 0 ? worktreePath.slice(0, at) : worktreePath;
}

/** The refusal, in the ticket's words. */
export function codexUntrustedMessage(worktreePath: string, why?: string): string {
  const base = `Codex's gate isn't trusted here: trust ${codexTrustTarget(worktreePath)} in Codex`;
  return why === undefined ? base : `${base} (${why})`;
}

// Hook input: Codex's payload as the Claude-shaped one `decide.ts` reads.

/** Shells whose `-c`/`-lc` argument is the command line. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', '/bin/sh', '/bin/bash', '/bin/zsh']);

/** A shell command as one line: a string as is, an argv as its `-c` script or quoted words. */
function commandLine(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return undefined;
  const argv = value as string[];
  if (argv.length === 0) return undefined;
  const flag = argv[1];
  if (argv.length === 3 && SHELLS.has(argv[0] as string) && (flag === '-c' || flag === '-lc')) {
    return argv[2];
  }
  return argv.map(shellQuote).join(' ');
}

const PATCH_PATH_LINE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

/** Every path an `apply_patch` envelope names (added, updated, deleted, moved to). */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = PATCH_PATH_LINE.exec(line.trim());
    const path = match?.[1]?.trim();
    if (path) out.push(path);
  }
  return [...new Set(out)];
}

/** Every string an `apply_patch` input might carry its patch in (unmeasured: read defensively). */
function patchTexts(input: Record<string, unknown>): string[] {
  const texts: string[] = [];
  for (const key of ['command', 'input', 'patch']) {
    const value = input[key];
    if (typeof value === 'string') texts.push(value);
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') texts.push(item);
    }
  }
  return texts;
}

/** The paths an edit names: the patch's, else a Claude-style `file_path`/`path`. Absolute, from `cwd`. */
function editPaths(input: Record<string, unknown>, cwd: string | undefined): string[] {
  const named = patchTexts(input).flatMap(patchPaths);
  for (const key of ['file_path', 'path']) {
    const value = input[key];
    if (named.length === 0 && typeof value === 'string' && value.length > 0) named.push(value);
  }
  const base = cwd ?? process.cwd();
  return [...new Set(named.map((p) => (isAbsolute(p) ? p : resolve(base, p))))];
}

const CODEX_EDIT_TOOLS = new Set(['apply_patch', 'Edit', 'Write']);
const CODEX_SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec_command']);

/**
 * Codex's `PreToolUse` input as the payload `HookService.preToolUse` reads:
 * a shell call is `Bash` with its command line; an edit is `Edit` with
 * `file_path` (the first path) and `file_paths` (all of them), or with no
 * path when none can be read (denied as an edit of unknown target). Any
 * other tool (MCP) passes as Codex named it. `no_additional_context_channel`
 * is set: whether Codex honours `additionalContext` is unmeasured, so normal
 * messages are not folded in (and acked) here.
 */
export function codexToClaudePayload(raw: Record<string, unknown>): ClaudePreToolUsePayload {
  const { agile_vendor: _vendor, ...payload } = raw;
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : undefined;
  const input = isPlainObject(payload.tool_input) ? payload.tool_input : {};
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const base: ClaudePreToolUsePayload = {
    ...payload,
    ...(cwd !== undefined ? { cwd } : {}),
    no_additional_context_channel: true,
  };
  if (toolName !== undefined && CODEX_SHELL_TOOLS.has(toolName)) {
    const command = commandLine(input.command ?? input.cmd);
    return {
      ...base,
      tool_name: 'Bash',
      tool_input: command !== undefined ? { command } : {},
      codex_tool_name: toolName,
    };
  }
  if (toolName !== undefined && CODEX_EDIT_TOOLS.has(toolName)) {
    const paths = editPaths(input, cwd);
    const [first] = paths;
    return {
      ...base,
      tool_name: 'Edit',
      tool_input: first !== undefined ? { file_path: first, file_paths: paths } : {},
      codex_tool_name: toolName,
    };
  }
  return { ...base, ...(toolName !== undefined ? { tool_name: toolName } : {}), tool_input: input };
}

// Fail closed: tool calls the hook never saw.

/** Per session, how many `PreToolUse` calls the daemon's hook answered. In memory: a session is a process. */
export class HookSightings {
  private readonly counts = new Map<string, number>();

  record(session: string): void {
    this.counts.set(session, (this.counts.get(session) ?? 0) + 1);
  }

  count(session: string): number {
    return this.counts.get(session) ?? 0;
  }

  forget(session: string): void {
    this.counts.delete(session);
  }
}

/** The stop's words (Needs me, the session's end, the thread). */
export const CODEX_UNGATED_REASON =
  "Codex ran a command its gate never saw: its hook isn't trusted or didn't fire";

/** ACP kinds Codex's hook must have seen: its reads and searches run as shell too, but report other kinds. */
const GATED_ACP_KINDS = new Set(['execute', 'edit']);

export interface CodexGateWatchOptions {
  session: string;
  sightings: Pick<HookSightings, 'count'>;
  /** Calls the hook never saw before the stop. Default 2. */
  threshold?: number;
  /** How long a call's hook record may trail its ACP report. Default 2000 ms. */
  graceMs?: number;
  onUngated: () => void;
}

/**
 * Counts a Codex session's `execute`/`edit` tool calls over ACP (each id
 * once) against its hook records. Every such call passed the hook first
 * when the hook runs (a blocked one never reaches ACP), so when the calls
 * outnumber the records by `threshold` (with zero records: the first
 * `threshold` calls), the hook is not running: `onUngated`, once.
 */
export class CodexGateWatch {
  private readonly seen = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fired = false;
  private readonly threshold: number;
  private readonly graceMs: number;

  constructor(private readonly options: CodexGateWatchOptions) {
    this.threshold = options.threshold ?? 2;
    this.graceMs = options.graceMs ?? 2000;
  }

  private unseen(): number {
    return this.seen.size - this.options.sightings.count(this.options.session);
  }

  toolCall(id: unknown, kind: unknown): void {
    if (this.fired || typeof kind !== 'string' || !GATED_ACP_KINDS.has(kind)) return;
    if (typeof id !== 'string' || this.seen.has(id)) return;
    this.seen.add(id);
    if (this.timer !== undefined || this.unseen() < this.threshold) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.fired || this.unseen() < this.threshold) return;
      this.fired = true;
      this.options.onUngated();
    }, this.graceMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.fired = true;
  }
}
