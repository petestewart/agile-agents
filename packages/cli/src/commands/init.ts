/**
 * `agile init` — bootstrap `.agile/` state in the current git repo (T004).
 * Unchanged behaviour from T004; moved here so `index.ts` is pure dispatch.
 */

import { AlreadyInitialisedError, discoverConfig, runInit } from '@agile-agents/daemon';

export interface CliInitResult {
  message: string;
  /** True when init refused because the repo was already bootstrapped — the
   * caller (`runCli`) turns this into a non-zero exit on stderr, not a
   * thrown exception, since it's a clean, expected outcome, not a crash. */
  alreadyInitialised: boolean;
}

export function runCliInit(cwd: string = process.cwd()): CliInitResult {
  const { repoRoot } = discoverConfig({ cwd });
  try {
    const result = runInit(repoRoot);
    return {
      message: `agile init: bootstrapped ${result.stateRoot} on branch ${result.branch} (${result.filesWritten.length} files)`,
      alreadyInitialised: false,
    };
  } catch (err) {
    if (err instanceof AlreadyInitialisedError) {
      return { message: err.message, alreadyInitialised: true };
    }
    throw err;
  }
}
