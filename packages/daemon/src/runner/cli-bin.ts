/**
 * How the daemon names its own CLI to the sessions it spawns, for the hook
 * command (a shell string) and the MCP stdio server (command + args). A
 * bare `agile` not on `$PATH` once made the hooks fail open and the MCP
 * server never start, so the run silently never converged. First hit wins:
 *   1. `AGILE_CLI_BIN` (a path or a name on `$PATH`);
 *   2. the monorepo's own CLI entry (`src/index.ts` or `dist/index.js`,
 *      this file's layout first) run with the current Bun;
 *   3. `agile` on `$PATH`;
 *   4. bare `agile`, flagged `missing` so the daemon warns loudly.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface CliInvocation {
  command: string;
  args: readonly string[];
}

export type CliBinSource = 'env' | 'workspace' | 'path' | 'missing';

export interface ResolvedCliBin extends CliInvocation {
  source: CliBinSource;
}

export interface ResolveCliBinOptions {
  env?: Record<string, string | undefined>;
  /** Runs a workspace entry; defaults to this process's Bun. */
  execPath?: string;
  /** This module's dir; injectable to simulate the `src` and `dist` layouts. */
  moduleDir?: string;
  exists?: (path: string) => boolean;
  /** `Bun.which`-shaped; injectable so tests never depend on `$PATH`. */
  which?: (name: string) => string | null;
}

/** Workspace CLI entries, in the order to try for this layout. */
function workspaceCandidates(moduleDir: string): string[] {
  const cliPkg = resolve(moduleDir, '..', '..', '..', 'cli');
  const src = join(cliPkg, 'src', 'index.ts');
  const dist = join(cliPkg, 'dist', 'index.js');
  return moduleDir.split(/[\\/]/).includes('dist') ? [dist, src] : [src, dist];
}

export function resolveCliBin(opts: ResolveCliBinOptions = {}): ResolvedCliBin {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const which = opts.which ?? ((name: string) => Bun.which(name));
  const execPath = opts.execPath ?? process.execPath;
  const moduleDir = opts.moduleDir ?? import.meta.dir;

  const fromEnv = env.AGILE_CLI_BIN?.trim();
  if (fromEnv) return { command: fromEnv, args: [], source: 'env' };

  for (const entry of workspaceCandidates(moduleDir)) {
    if (exists(entry)) return { command: execPath, args: [entry], source: 'workspace' };
  }

  if (which('agile')) return { command: 'agile', args: [], source: 'path' };
  return { command: 'agile', args: [], source: 'missing' };
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quote escaping, only when the word needs it. */
export function shellQuote(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The invocation as one shell command prefix (Claude runs hook commands through a shell). */
export function cliInvocationToShell(cli: CliInvocation): string {
  return [cli.command, ...cli.args].map(shellQuote).join(' ');
}

/** Accepts a bare string (`'agile'`, a path) or a structured invocation. */
export function normalizeCliBin(cliBin: string | CliInvocation | undefined): CliInvocation {
  if (cliBin === undefined) return { command: 'agile', args: [] };
  if (typeof cliBin === 'string') return { command: cliBin, args: [] };
  return cliBin;
}
