/**
 * How the daemon names its own CLI to the vendor sessions it spawns.
 *
 * Every session gets two things that must actually run on the host: the
 * tier-1 hook command in `.claude/settings.json` (`<agile> hook <event>`,
 * a shell string) and the MCP stdio server (`<agile> mcp --agent … --ticket
 * …`, exec'd as command + args). Until the first live run on a laptop, the
 * daemon passed the bare name `agile` for both — which only works when the
 * CLI has been linked onto `$PATH`. When it hasn't, the hooks fail (and a
 * missing binary is a non-blocking hook error to Claude, so the session
 * runs *ungated*) and the MCP server never starts, so no agent can reach a
 * single daemon verb: the sprint silently never converges and the liveness
 * watchdog aborts the run five minutes later.
 *
 * Resolution order (first hit wins):
 *   1. `AGILE_CLI_BIN` — an operator-chosen executable (absolute path or a
 *      name on `$PATH`), same override convention as `AGILE_SOCKET_PATH`.
 *   2. The monorepo's own CLI entry next to this package, run through the
 *      current Bun executable — `packages/cli/src/index.ts` from source,
 *      `packages/cli/dist/index.js` from a built tree. Whichever layout this
 *      file is running from is tried first.
 *   3. `agile` on `$PATH` (a globally installed or `bun link`ed CLI).
 *   4. Bare `agile` anyway, flagged `missing` so the daemon can warn loudly.
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
  /** The executable to run a workspace entry with — defaults to this process's own Bun. */
  execPath?: string;
  /** Directory of this module — defaults to `import.meta.dir`. Injectable so tests can simulate the `src` and `dist` layouts. */
  moduleDir?: string;
  exists?: (path: string) => boolean;
  /** `Bun.which`-shaped lookup — injectable so tests never depend on the host `$PATH`. */
  which?: (name: string) => string | null;
}

/** Workspace CLI entries relative to `packages/daemon/{src,dist}/runner/`, in the order to try for a given layout. */
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

/** POSIX single-quote escaping for one word — only applied when the word needs it, so the common case stays byte-identical to the bare name. */
export function shellQuote(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The invocation as one shell command prefix, for `.claude/settings.json`'s hook command (which Claude runs through a shell). */
export function cliInvocationToShell(cli: CliInvocation): string {
  return [cli.command, ...cli.args].map(shellQuote).join(' ');
}

/** Accepts the older bare-string form (`'agile'`, `/usr/local/bin/agile`) as well as a structured invocation. */
export function normalizeCliBin(cliBin: string | CliInvocation | undefined): CliInvocation {
  if (cliBin === undefined) return { command: 'agile', args: [] };
  if (typeof cliBin === 'string') return { command: cliBin, args: [] };
  return cliBin;
}
