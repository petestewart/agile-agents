/**
 * `agile init` — create the state home if missing (T111). The home is
 * `$AGILE_HOME` (default `~/.agile/`); nothing is written inside the repo.
 */

import { discoverConfig, runInit } from '@agile-agents/daemon';

export interface CliInitResult {
  message: string;
  /** Kept for callers/tests: true when the home already had every file (a no-op re-run). */
  alreadyInitialised: boolean;
}

/**
 * T125: takes no cwd. The home is the only input, and it comes from
 * `$AGILE_HOME`/the default — `agile init` works from any directory.
 */
export function runCliInit(): CliInitResult {
  const { home } = discoverConfig();
  const result = runInit(home);
  return {
    message: `agile init: state home ${result.home} ready (${result.filesWritten.length} files written)`,
    alreadyInitialised: result.filesWritten.length === 0,
  };
}
