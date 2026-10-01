/**
 * T480 (D49): one install per vendor. `claude-agent-acp` bundles its own
 * Claude Code (through `claude-agent-sdk`) and `codex-acp` bundles
 * `@openai/codex`, so the daemon ran a second copy beside the operator's,
 * and a model their Claude Code already had (Sonnet 5.5) was missing until
 * the bridge moved (T479). Both bridges take an override, checked in their
 * dists: `CLAUDE_CODE_EXECUTABLE` (claude-agent-acp 0.84.0, `acp-agent.js`:
 * `pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE ?? …`) and
 * `CODEX_PATH` (codex-acp 1.10.0, README: "run a specific Codex executable
 * instead of the bundled package dependency").
 *
 * When the vendor's CLI is on PATH and the home's `installed_cli` switch is
 * on (the default), the session's env points the bridge at it. When it is
 * not installed, or the switch is off, the bundled copy runs, as before.
 * Gemini, Cursor, Grok and Pi already run the installed CLI.
 */

import { realpathSync, statSync } from 'node:fs';
import {
  type HomeConfig,
  INSTALLED_CLI_VENDORS,
  type InstalledCliVendor,
} from '@agile-agents/shared';

interface InstalledCliSpec {
  /** The command on PATH. */
  bin: string;
  /** The bridge's override variable. */
  env: string;
  /** The CLI in words. */
  label: string;
}

export const INSTALLED_CLI: Readonly<Record<InstalledCliVendor, InstalledCliSpec>> = Object.freeze({
  claude: { bin: 'claude', env: 'CLAUDE_CODE_EXECUTABLE', label: 'Claude Code' },
  codex: { bin: 'codex', env: 'CODEX_PATH', label: 'Codex' },
});

/** The installed CLI a session of this vendor runs through its bridge. */
export interface InstalledCli {
  vendor: InstalledCliVendor;
  label: string;
  /** Where it was found on PATH. */
  path: string;
  /** The env the bridge reads (`{CLAUDE_CODE_EXECUTABLE: path}`). */
  env: Record<string, string>;
}

/** What Settings says about one vendor: the switch, and what a session would run. */
export interface InstalledCliStatus {
  vendor: InstalledCliVendor;
  label: string;
  on: boolean;
  /** The installed CLI on PATH, when there is one. */
  path?: string;
}

export type WhichFn = (bin: string) => string | null;

const defaultWhich: WhichFn = (bin) => Bun.which(bin);

function isInstalledCliVendor(vendor: string): vendor is InstalledCliVendor {
  return (INSTALLED_CLI_VENDORS as readonly string[]).includes(vendor);
}

/** The home's switch for `vendor`: on unless set to `false`. */
export function installedCliOn(
  config: Pick<HomeConfig, 'installed_cli'> | undefined,
  vendor: InstalledCliVendor,
): boolean {
  return config?.installed_cli?.[vendor] !== false;
}

/**
 * The installed CLI a new `vendor` session should run, or `undefined`: a
 * vendor without a bundled copy, the switch off, or nothing on PATH.
 */
export function installedCliFor(
  vendor: string,
  config: Pick<HomeConfig, 'installed_cli'> | undefined,
  which: WhichFn = defaultWhich,
): InstalledCli | undefined {
  if (!isInstalledCliVendor(vendor) || !installedCliOn(config, vendor)) return undefined;
  const spec = INSTALLED_CLI[vendor];
  let path: string | null = null;
  try {
    path = which(spec.bin);
  } catch {
    path = null;
  }
  if (path === null || path === '') return undefined;
  return { vendor, label: spec.label, path, env: { [spec.env]: path } };
}

/** Settings → Agents: each bridged vendor's switch and what it finds. */
export function installedCliStatus(
  config: Pick<HomeConfig, 'installed_cli'> | undefined,
  which: WhichFn = defaultWhich,
): InstalledCliStatus[] {
  return INSTALLED_CLI_VENDORS.map((vendor) => {
    const spec = INSTALLED_CLI[vendor];
    let path: string | null = null;
    try {
      path = which(spec.bin);
    } catch {
      path = null;
    }
    return {
      vendor,
      label: spec.label,
      on: installedCliOn(config, vendor),
      ...(path !== null && path !== '' ? { path } : {}),
    };
  });
}

/**
 * The installed CLI a session actually runs: only an unsandboxed one (a
 * sandbox backend may not see or read the host's binary; it keeps the
 * bridge's bundled copy).
 */
export function installedCliForSpawn(
  installed: InstalledCli | undefined,
  sandboxBackend: string,
): InstalledCli | undefined {
  return installed !== undefined && sandboxBackend === 'none' ? installed : undefined;
}

/**
 * T495: the identity of the CLI binary a session runs, taken when it
 * spawns: where the command resolves on disk, its modification time and
 * size. An update in place (`npm i -g`, `brew upgrade`, the CLI's own
 * updater) changes one of them.
 */
export interface CliStamp {
  /** The command as found (on PATH, or as given). */
  path: string;
  /** Where it resolves (symlinks followed). */
  real: string;
  mtimeMs: number;
  size: number;
}

/** `path`'s stamp now, or `undefined` when it can't be read. */
export function cliStamp(path: string): CliStamp | undefined {
  try {
    const real = realpathSync(path);
    const st = statSync(real);
    return { path, real, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return undefined;
  }
}

/**
 * Whether the binary behind `stamp.path` changed since the stamp: it now
 * resolves elsewhere, or the file there is newer or a different size. A
 * binary that can't be read now counts as changed (it was moved or removed).
 */
export function cliStampChanged(
  stamp: CliStamp,
  now: (path: string) => CliStamp | undefined = cliStamp,
): boolean {
  const current = now(stamp.path);
  return (
    current === undefined ||
    current.real !== stamp.real ||
    current.mtimeMs !== stamp.mtimeMs ||
    current.size !== stamp.size
  );
}

/**
 * T495: the CLI binary a session of `provider` runs, to stamp: the
 * installed CLI the bridge points at (T480), else the provider's own
 * command when it is the vendor's CLI (Gemini, Cursor, Grok, Pi's shim).
 * `undefined` for an `npx` bridge with its bundled copy: that copy only
 * moves by a code change.
 */
export function sessionCliPath(
  provider: { command: string },
  installed: InstalledCli | undefined,
  which: WhichFn = defaultWhich,
): string | undefined {
  if (installed !== undefined) return installed.path;
  if (provider.command === 'npx' || provider.command === 'bun') return undefined;
  if (provider.command.includes('/')) return provider.command;
  try {
    return which(provider.command) ?? undefined;
  } catch {
    return undefined;
  }
}
