/**
 * Installs the `agile` Pi extension (`agile-extension.ts`) into a Pi agent
 * directory's `extensions/` folder, and patches its `settings.json` for
 * `quietStartup` (T022 scope: "an `agile` Pi extension installed to
 * `~/.pi/agent/extensions/` ... `quietStartup` handling").
 *
 * The install step is a daemon/CLI action, not something baked into the
 * copied extension file itself — same split as Claude's
 * `hook/settings.ts`'s `writeClaudeSettings` (config generation) versus
 * `runner/session.ts` (the caller that actually invokes it per spawn).
 * `resolvePiAgentDir` mirrors `@earendil-works/pi-coding-agent`'s own
 * `getAgentDir()` (verified during T022's verify-before-build against
 * `dist/config.js`: `process.env.PI_CODING_AGENT_DIR ?? join(homedir(),
 * '.pi', 'agent')` — not re-implemented from that package, since depending
 * on it here would add a real dependency just to read one env var
 * convention) — passing `agentDir` explicitly (what every test does, via a
 * temp dir) always wins over both, so nothing here ever touches the real
 * home directory at test time.
 *
 * Idempotent by content: `installPiExtension` skips the write when the
 * target file's bytes already match (no spurious mtime bump / no risk of
 * clobbering a hand-edited copy that happens to already be identical), and
 * `patchQuietStartup` only rewrites `settings.json` when `quietStartup`
 * isn't already `true` — merging every other key untouched, same contract
 * as `writeClaudeSettings`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `PI_CODING_AGENT_DIR` — the same env var `@earendil-works/pi-coding-agent` and `pi-acp` both honor (verified in `node_modules/pi-acp@0.0.33/dist/index.js`: `process.env.PI_CODING_AGENT_DIR ? resolve(...) : join(homedir(), ".pi", "agent")`). */
export const PI_AGENT_DIR_ENV_VAR = 'PI_CODING_AGENT_DIR';

export interface ResolvePiAgentDirOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

/** Resolves the Pi agent config directory the same way `pi`/`pi-acp` do. Never called with a real `homedir()` in a test — tests always pass `agentDir` explicitly to `installPiExtension` instead. */
export function resolvePiAgentDir(opts: ResolvePiAgentDirOptions = {}): string {
  const env = opts.env ?? process.env;
  const envDir = env[PI_AGENT_DIR_ENV_VAR];
  if (envDir) return envDir;
  return join(opts.homeDir ?? homedir(), '.pi', 'agent');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface InstallPiExtensionOptions {
  /** Pi agent config directory (`resolvePiAgentDir()`'s result, or an injected temp dir in tests). */
  agentDir: string;
  /** The extension's full source text — `install.ts`'s caller reads `agile-extension.ts` itself (see this file's header) and passes its contents through unchanged. */
  extensionSource: string;
  /** Set `quietStartup: true` in `settings.json` (spike-findings.md §C4: "Noise: pi-acp injects a 'startup info' block ... set `quietStartup: true` ... for agent use"). Default true. */
  quietStartup?: boolean;
}

export interface InstallPiExtensionResult {
  extensionPath: string;
  settingsPath: string;
  /** False when the extension file already had identical content on disk (idempotent no-op write). */
  extensionWritten: boolean;
  /** False when `settings.json` already had `quietStartup` set as requested. */
  settingsWritten: boolean;
}

/**
 * Writes `<agentDir>/extensions/agile.ts` and patches
 * `<agentDir>/settings.json`. Safe to call on every daemon startup / every
 * Pi session spawn — both writes are idempotent no-ops once the target
 * state already matches.
 */
export function installPiExtension(opts: InstallPiExtensionOptions): InstallPiExtensionResult {
  const { agentDir, extensionSource } = opts;
  const quietStartup = opts.quietStartup ?? true;

  const extensionsDir = join(agentDir, 'extensions');
  mkdirSync(extensionsDir, { recursive: true });
  const extensionPath = join(extensionsDir, 'agile.ts');

  let extensionWritten = true;
  if (existsSync(extensionPath)) {
    const current = readFileSync(extensionPath, 'utf8');
    extensionWritten = current !== extensionSource;
  }
  if (extensionWritten) {
    writeFileSync(extensionPath, extensionSource);
  }

  mkdirSync(agentDir, { recursive: true });
  const settingsPath = join(agentDir, 'settings.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (isPlainObject(parsed)) existing = parsed;
  }

  const settingsWritten = existing.quietStartup !== quietStartup;
  if (settingsWritten) {
    const merged = { ...existing, quietStartup };
    writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  }

  return { extensionPath, settingsPath, extensionWritten, settingsWritten };
}
