/**
 * T506: Codex's own `PreToolUse` hook, the same tier-1 gate as Claude's
 * (`settings.ts`), measured in design/spike-findings.md §C5:
 *
 * - Codex reads hooks from `hooks.json` (`{hooks: {PreToolUse: [{matcher,
 *   hooks: [{type: 'command', command, statusMessage}]}]}}`), also under
 *   codex-acp (`codex app-server`).
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
 * - Project trust (option b, Pete 2026-10-02): the daemon reads
 *   `$CODEX_HOME/config.toml` (default `~/.codex`), never writes it, and
 *   refuses a start in a project Codex doesn't trust (`codexTrustFor`).
 *
 * T512 (§C5 round 5, Codex 0.159.3): Codex trusts **each hook** separately.
 * A new or changed hook is "review required" in `/hooks` and skipped
 * silently until trusted; trusting it writes `[hooks.state."<hooks.json
 * path>:pre_tool_use:<i>:<j>"] trusted_hash` to `config.toml` (`<i>` the
 * entry's index in `PreToolUse`, `<j>` the hook's in that entry). A trusted
 * project hook at the repo root did not fire for a session in
 * `<repo>/.worktrees/<id>` (T511 failed); three user-level entries in
 * `$CODEX_HOME/hooks.json`, trusted once, gated a worktree node. So:
 *
 * - The gate is those three entries (`installCodexGate`, run only by the
 *   operator's `agile codex install-gate`: the daemon never writes Codex's
 *   `hooks.json` on its own). They name only `<home>/agile-pre-tool-use.sh`,
 *   so they never change and Codex's trust holds.
 * - The script (`renderCodexGateScript`) is rewritten, only when changed, at
 *   every Codex start: it carries the CLI's path, the socket, the home and
 *   every registered repo root. The CLI gates a call from under any
 *   `<repo>/.worktrees/` or the home (`codexCallGated`) and allows any
 *   other at once, so the operator's own Codex anywhere runs as before.
 * - A start reads `hooks.json` and `config.toml` (`codexGateStatus`) and is
 *   refused while the entries are missing or untrusted.
 * - T506/T511's `.codex/` files in a repo are swept (`sweepLegacyCodexHooks`).
 *
 * The script carries no session id (a worker and its reviewer share one
 * worktree, and every Codex session shares the script); the session env's
 * `AGILE_AGENT` is the hint, as for Claude.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  CODEX_GATE_MISSING_LEAD,
  CODEX_GATE_UNTRUSTED_LEAD,
  type CodexGateEntryStatus,
  type CodexGateInstallResult,
  type CodexGateStatus,
  type CodexLegacySweep,
  CODEX_UNGATED_REASON,
  CODEX_UNTRUSTED_LEAD,
} from '@agile-agents/shared';
import { shellQuote } from '../runner/cli-bin';
import { atomicWriteFile } from '../store/fs';
import { isTracked } from './settings';
import type { ClaudePreToolUsePayload } from './types';

/** The Codex layer a repo's legacy (T506/T511) files sit in. */
export const CODEX_DIR = '.codex';
export const CODEX_HOOKS_FILE = 'hooks.json';
/** The executable the hook entries run: `<home>/agile-pre-tool-use.sh` (T512). */
export const CODEX_GATE_SCRIPT = 'agile-pre-tool-use.sh';

/**
 * The tools gated, as Codex's regex matchers: shell (`Bash`, also how Codex
 * runs its own reads and searches), edits (`apply_patch`, which Codex's
 * docs say `Edit` and `Write` also match) and MCP tools (Claude's `*`
 * matcher covers them too).
 */
export const CODEX_HOOK_MATCHERS: readonly string[] = ['Bash', 'apply_patch|Edit|Write', 'mcp__.*'];

/** What Codex shows while the hook runs, and what `/hooks` lists the entries as. */
export const CODEX_GATE_STATUS_MESSAGE = 'agile gate';

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

export interface CodexGateScriptOptions {
  /** The `agile` CLI as a shell prefix (`cliInvocationToShell`). */
  agileBin: string;
  /** Set as `AGILE_SOCKET_PATH` for the CLI, as Claude's hook command does. */
  socketPath?: string;
  /** The agile home: the script lives in it, and calls from under it (`sessions/<id>`) are gated. */
  home: string;
  /** Every registered repo root: calls from under each `<root>/.worktrees/` are gated. */
  repoRoots: readonly string[];
}

/** `<home>/agile-pre-tool-use.sh`. */
export function codexGateScriptPath(home: string): string {
  return join(home, CODEX_GATE_SCRIPT);
}

/** `$CODEX_HOME/hooks.json`. */
export function codexHooksPath(codexHome: string): string {
  return join(codexHome, CODEX_HOOKS_FILE);
}

/**
 * The script every entry runs: the CLI in Codex's mode with the home and
 * each repo root (sorted, so the bytes depend on the set only), and exit 2
 * if it can't run.
 */
export function renderCodexGateScript(options: CodexGateScriptOptions): string {
  const env = options.socketPath ? `AGILE_SOCKET_PATH=${shellQuote(options.socketPath)} ` : '';
  const repos = [...new Set(options.repoRoots)]
    .sort()
    .map((root) => ` --repo ${shellQuote(root)}`)
    .join('');
  return [
    '#!/bin/sh',
    '# agile-agents: the Codex PreToolUse gate (T506, T512). $CODEX_HOME/hooks.json runs it; the daemon',
    '# rewrites it at every Codex start and `agile codex install-gate` writes it: edits are overwritten.',
    '# Exit 2 blocks the call; any other failure would let it run, so a CLI that cannot run blocks.',
    `${env}${options.agileBin} hook pre-tool-use --vendor codex --home ${shellQuote(options.home)}${repos} || exit 2`,
    '',
  ].join('\n');
}

/** Writes `content` unless the file already holds it; a write is a rename, so a reader never sees half a file. */
function writeIfChanged(path: string, content: string, mode?: number): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) {
    if (mode !== undefined) chmodSync(path, mode);
    return false;
  }
  atomicWriteFile(path, content, mode);
  return true;
}

/**
 * Writes `<home>/agile-pre-tool-use.sh` (mode 0755) when its bytes differ:
 * a Codex running it is never raced (an unchanged file is not touched, a
 * changed one is renamed into place). `changed` says whether it was written.
 */
export function writeCodexGateScript(options: CodexGateScriptOptions): {
  path: string;
  changed: boolean;
} {
  const path = codexGateScriptPath(options.home);
  return { path, changed: writeIfChanged(path, renderCodexGateScript(options), 0o755) };
}

/** The `hooks.json` entries for a script at `scriptPath`. */
export function renderCodexHooks(scriptPath: string): CodexGateHooks {
  return {
    hooks: {
      PreToolUse: CODEX_HOOK_MATCHERS.map((matcher) => ({
        matcher,
        hooks: [{ type: 'command', command: scriptPath, statusMessage: CODEX_GATE_STATUS_MESSAGE }],
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
 * A `PreToolUse` list with ours taken out: every matcher of someone else's
 * kept as it is (ours taken out of it; a matcher left with none of its own
 * hooks dropped). `changed` says whether any of ours was there.
 */
function withoutOurs(existing: unknown): { kept: unknown[]; changed: boolean } {
  const kept: unknown[] = [];
  let changed = false;
  for (const matcher of Array.isArray(existing) ? existing : []) {
    if (!isPlainObject(matcher) || !Array.isArray(matcher.hooks)) {
      kept.push(matcher);
      continue;
    }
    const theirs = matcher.hooks.filter((entry) => !isOurHook(entry));
    if (theirs.length === matcher.hooks.length) {
      kept.push(matcher);
      continue;
    }
    changed = true;
    if (theirs.length > 0) kept.push({ ...matcher, hooks: theirs });
  }
  return { kept, changed };
}

/** Reads a `hooks.json`: absent, its object, or why it can't be used (never overwritten then). */
function readHooksFile(
  path: string,
): { kind: 'absent' } | { kind: 'ok'; file: Record<string, unknown> } | { kind: 'bad'; why: string } {
  if (!existsSync(path)) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { kind: 'bad', why: `${path} isn't valid JSON` };
  }
  if (!isPlainObject(parsed)) return { kind: 'bad', why: `${path} isn't a JSON object` };
  return { kind: 'ok', file: parsed };
}

/** Where each of our matchers sits: `PreToolUse[index].hooks[hook]` runs a gate script. */
function ourEntries(file: Record<string, unknown>): Map<string, { index: number; hook: number }> {
  const found = new Map<string, { index: number; hook: number }>();
  const hooks = isPlainObject(file.hooks) ? file.hooks : {};
  const list = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  list.forEach((matcher, index) => {
    if (!isPlainObject(matcher) || typeof matcher.matcher !== 'string') return;
    if (!CODEX_HOOK_MATCHERS.includes(matcher.matcher) || found.has(matcher.matcher)) return;
    if (!Array.isArray(matcher.hooks)) return;
    const hook = matcher.hooks.findIndex(isOurHook);
    if (hook >= 0) found.set(matcher.matcher, { index, hook });
  });
  return found;
}

/** Whether the file already holds our three entries exactly as `renderCodexHooks` writes them. */
function hasExactGate(file: Record<string, unknown>, scriptPath: string): boolean {
  const hooks = isPlainObject(file.hooks) ? file.hooks : {};
  const list = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const want = renderCodexHooks(scriptPath).hooks.PreToolUse;
  const ours = list.filter(
    (m) => isPlainObject(m) && Array.isArray(m.hooks) && m.hooks.some(isOurHook),
  );
  return (
    ours.length === want.length &&
    want.every((w) => ours.some((m) => JSON.stringify(m) === JSON.stringify(w)))
  );
}

export interface InstallCodexGateOptions {
  codexHome: string;
  script: CodexGateScriptOptions;
  /** Repo roots whose legacy `.codex/` files are swept (every registered one). */
  sweep?: readonly string[];
}

/**
 * T512: `agile codex install-gate`, the operator's explicit step. Merges our
 * three entries into `$CODEX_HOME/hooks.json` (the file and its directory
 * created when missing; other keys, events and someone else's matchers
 * kept; nothing written when all three are already there, so their index
 * and Codex's trust hold), writes the script, and sweeps each repo's legacy
 * files. A `hooks.json` that isn't a JSON object is refused, never
 * overwritten: it may hold the operator's own hooks.
 */
export function installCodexGate(options: InstallCodexGateOptions): CodexGateInstallResult {
  const hooksPath = codexHooksPath(options.codexHome);
  const scriptPath = codexGateScriptPath(options.script.home);
  const read = readHooksFile(hooksPath);
  if (read.kind === 'bad') {
    throw new Error(`${read.why}; Codex's gate can't be merged into it (fix or move it, then run again)`);
  }
  const existing = read.kind === 'ok' ? read.file : {};
  let hooks: CodexGateInstallResult['hooks'] = 'unchanged';
  if (!hasExactGate(existing, scriptPath)) {
    const existingHooks = isPlainObject(existing.hooks) ? existing.hooks : {};
    const merged: CodexHooksFile = {
      ...existing,
      hooks: {
        ...existingHooks,
        PreToolUse: [
          ...withoutOurs(existingHooks.PreToolUse).kept,
          ...renderCodexHooks(scriptPath).hooks.PreToolUse,
        ],
      },
    };
    atomicWriteFile(hooksPath, `${JSON.stringify(merged, null, 2)}\n`);
    hooks = 'added';
  }
  const script = writeCodexGateScript(options.script);
  const swept = [...new Set(options.sweep ?? [])].map((dir) => sweepLegacyCodexHooks(dir));
  return {
    hooks_path: hooksPath,
    hooks,
    script_path: script.path,
    script: script.changed ? 'written' : 'unchanged',
    swept,
    status: codexGateStatus(options.codexHome, options.script.home),
  };
}

/** `~` and `~/…` as the user's home. */
function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

const HOOK_STATE_KEY = /^(.+):pre_tool_use:(\d+):(\d+)$/;

/**
 * The `[hooks.state."<path>:pre_tool_use:<i>:<j>"]` entries of `config.toml`
 * that carry a `trusted_hash` and name `hooksPath` (as given, realpath'd,
 * `~` expanded): their `i:j`. Read only; nothing of the file is returned.
 */
function trustedHookSlots(codexHome: string, hooksPath: string): Set<string> {
  const slots = new Set<string>();
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(join(codexHome, 'config.toml'), 'utf8'));
  } catch {
    return slots;
  }
  const hooks = isPlainObject(parsed) ? parsed.hooks : undefined;
  const state = isPlainObject(hooks) ? hooks.state : undefined;
  if (!isPlainObject(state)) return slots;
  const ours = new Set(codexPathForms(hooksPath));
  for (const [key, value] of Object.entries(state)) {
    const match = HOOK_STATE_KEY.exec(key);
    if (!match || !isPlainObject(value)) continue;
    const hash = value.trusted_hash;
    if (typeof hash !== 'string' || hash.length === 0) continue;
    const path = expandTilde(match[1] as string);
    if (!isAbsolute(path)) continue;
    if (!codexPathForms(path).some((form) => ours.has(form))) continue;
    slots.add(`${match[2]}:${match[3]}`);
  }
  return slots;
}

/**
 * T512: whether the user-level gate is installed (our three entries in
 * `$CODEX_HOME/hooks.json`, recognised by the script's file name) and
 * trusted (each one's slot has a `trusted_hash` in `config.toml`). Read
 * only: no hash, nor anything else of `config.toml`, is returned.
 */
export function codexGateStatus(codexHome: string, home: string): CodexGateStatus {
  const hooksPath = codexHooksPath(codexHome);
  const base = { hooks_path: hooksPath, script_path: codexGateScriptPath(home) };
  const read = readHooksFile(hooksPath);
  const found = read.kind === 'ok' ? ourEntries(read.file) : new Map();
  const slots = found.size > 0 ? trustedHookSlots(codexHome, hooksPath) : new Set<string>();
  const entries: CodexGateEntryStatus[] = CODEX_HOOK_MATCHERS.map((matcher) => {
    const at = found.get(matcher);
    if (at === undefined) return { matcher, trusted: false };
    return { matcher, index: at.index, trusted: slots.has(`${at.index}:${at.hook}`) };
  });
  const installed = entries.every((e) => e.index !== undefined);
  return {
    ...base,
    installed,
    trusted: installed && entries.every((e) => e.trusted),
    entries,
    ...(read.kind === 'bad' ? { problem: read.why } : {}),
  };
}

/**
 * T512: why a Codex start must be refused for its gate, or undefined when
 * all three entries are there and trusted. The words start with the shared
 * leads, which the cockpit's stop card reads.
 */
export function codexGateRefusal(codexHome: string, home: string): string | undefined {
  const status = codexGateStatus(codexHome, home);
  if (!status.installed) {
    const why = status.problem ?? `no agile gate entries in ${status.hooks_path}`;
    return `${CODEX_GATE_MISSING_LEAD} (${why})`;
  }
  if (!status.trusted) {
    const trusted = status.entries.filter((e) => e.trusted).length;
    return `${CODEX_GATE_UNTRUSTED_LEAD} (${trusted} of ${status.entries.length} trusted)`;
  }
  return undefined;
}

/**
 * T512: removes T506/T511's files from `<dir>/.codex/`: our entries in its
 * `hooks.json` (everyone else's kept; the file deleted when no hook of any
 * event and no other key is left), the script beside it, and the `.codex`
 * dir when that leaves it empty. A file that isn't valid JSON, or that the
 * repo tracks, is left as it is, and the result says so. A stale script
 * there would `exit 2` (its old CLI path) and block the operator's own
 * Codex at the repo root.
 */
export function sweepLegacyCodexHooks(dir: string): CodexLegacySweep {
  const codexDir = join(dir, CODEX_DIR);
  const hooksPath = join(codexDir, CODEX_HOOKS_FILE);
  const scriptPath = join(codexDir, CODEX_GATE_SCRIPT);
  const removed: string[] = [];
  const left: string[] = [];
  if (!existsSync(codexDir)) return { dir, removed };
  if (existsSync(hooksPath)) {
    const read = readHooksFile(hooksPath);
    if (isTracked(dir, `${CODEX_DIR}/${CODEX_HOOKS_FILE}`)) {
      left.push(`${hooksPath} is tracked by git; left as it is`);
    } else if (read.kind === 'bad') {
      left.push(`${read.why}; left as it is`);
    } else if (read.kind === 'ok') {
      const file = read.file;
      const hooks = isPlainObject(file.hooks) ? file.hooks : undefined;
      const { kept, changed } = withoutOurs(hooks?.PreToolUse);
      if (hooks !== undefined && changed) {
        // Every other event in its place; `PreToolUse` without ours, or gone when nothing is left in it.
        const rest = Object.fromEntries(
          Object.entries(hooks).flatMap(([event, value]): [string, unknown][] =>
            event !== 'PreToolUse' ? [[event, value]] : kept.length > 0 ? [[event, kept]] : [],
          ),
        );
        const { hooks: _hooks, ...others } = file;
        const anyHook = Object.values(rest).some((v) => !Array.isArray(v) || v.length > 0);
        if (!anyHook && Object.keys(others).length === 0) {
          rmSync(hooksPath);
        } else {
          atomicWriteFile(hooksPath, `${JSON.stringify({ ...file, hooks: rest }, null, 2)}\n`);
        }
        removed.push(hooksPath);
      }
    }
  }
  if (existsSync(scriptPath)) {
    if (isTracked(dir, `${CODEX_DIR}/${CODEX_GATE_SCRIPT}`)) {
      left.push(`${scriptPath} is tracked by git; left as it is`);
    } else {
      rmSync(scriptPath);
      removed.push(scriptPath);
    }
  }
  try {
    if (readdirSync(codexDir).length === 0) {
      rmdirSync(codexDir);
      removed.push(codexDir);
    }
  } catch {
    // Gone or unreadable: nothing more to sweep.
  }
  return { dir, removed, ...(left.length > 0 ? { left: left.join('; ') } : {}) };
}

// Which calls the CLI gates (T512): pure path logic, shared with `agile hook`.

/** A path as given (resolved) and its real path: its nearest existing ancestor's, with the rest appended. */
export function codexPathForms(path: string): string[] {
  const resolved = resolve(path);
  const rest: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return [...new Set([resolved, join(realpathSync(current), ...rest)])];
    } catch {
      const parent = dirname(current);
      if (parent === current) return [resolved];
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/** `path` is `base` or under it, comparing strings only. */
function atOrUnder(path: string, base: string): boolean {
  if (path === base) return true;
  const rel = relative(base, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** What the gate script tells the CLI: the repo roots, and (T512) the home. */
export interface CodexGateScope {
  repos: readonly string[];
  /**
   * T512: the agile home. Set, a call is gated when its `cwd` is strictly
   * inside any `<repo>/.worktrees/` or at or under the home. Absent (a
   * T511 script, `--repo` alone): at or under any `<repo>/.worktrees`.
   */
  home?: string;
}

/**
 * Whether a Codex hook call with this input `cwd` is the daemon's to gate.
 * Every form of the `cwd` (as given, realpath) is compared with every form
 * of each base; a `cwd` that is missing, not a string or not absolute is
 * gated (fail closed). Decided from the arguments only: no daemon call.
 */
export function codexCallGated(cwd: unknown, scope: CodexGateScope): boolean {
  if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) return true;
  const forms = codexPathForms(cwd);
  const strict = scope.home !== undefined;
  for (const repo of scope.repos) {
    const bases = codexPathForms(join(resolve(repo), '.worktrees'));
    const inside = forms.some((form) =>
      bases.some((base) => (strict ? form !== base : true) && atOrUnder(form, base)),
    );
    if (inside) return true;
  }
  if (scope.home !== undefined) {
    const homes = codexPathForms(scope.home);
    if (forms.some((form) => homes.some((home) => atOrUnder(form, home)))) return true;
  }
  return false;
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
      const covers = forms.some((form) => roots.some((root) => atOrUnder(form, root)));
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
  const base = `${CODEX_UNTRUSTED_LEAD}${codexTrustTarget(worktreePath)} in Codex`;
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

/** The stop's words (Needs me, the session's end, the thread); T508: defined in shared. */
export { CODEX_UNGATED_REASON };

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
