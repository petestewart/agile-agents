#!/usr/bin/env bun
/**
 * @agile-agents/cli
 *
 * agile: the Agile Agents command-line interface.
 *
 * T004 scope: `agile init` and `agile daemon start`, thin wrappers over
 * @agile-agents/daemon library functions (design/agile-agents-design.md §18
 * "Technical shape": "same client lib" as the daemon). T008 fleshes out
 * status/chat/send/approve/halt/hook. No CLI framework dependency — argv
 * parsing here is deliberately minimal.
 */

import {
  AlreadyInitialisedError,
  discoverConfig,
  installShutdownSignals,
  runInit,
  startDaemon,
} from '@agile-agents/daemon';

export const PACKAGE_NAME = '@agile-agents/cli';

function usage(): string {
  return [
    'usage: agile <command>',
    '',
    'commands:',
    '  init            bootstrap .agile/ state in the current git repo',
    '  daemon start    start agiled in the foreground for this repo',
  ].join('\n');
}

export function runCliInit(cwd: string = process.cwd()): string {
  const { repoRoot } = discoverConfig({ cwd });
  try {
    const result = runInit(repoRoot);
    return `agile init: bootstrapped ${result.stateRoot} on branch ${result.branch} (${result.filesWritten.length} files)`;
  } catch (err) {
    if (err instanceof AlreadyInitialisedError) {
      return err.message;
    }
    throw err;
  }
}

export async function runCliDaemonStart(cwd: string = process.cwd()): Promise<string> {
  const handle = await startDaemon({ cwd });
  installShutdownSignals(handle);
  return (
    `agiled started: pid=${handle.lock.pid} ` +
    `http=http://127.0.0.1:${handle.http.port} socket=${handle.rpc.socketPath} ` +
    `state=${handle.config.stateRoot}`
  );
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, sub] = argv;

  if (command === 'init') {
    console.log(runCliInit());
    return 0;
  }

  if (command === 'daemon' && sub === 'start') {
    console.log(await runCliDaemonStart());
    // Foreground process: keep the event loop alive until shutdown signals fire.
    return new Promise(() => {});
  }

  console.error(usage());
  return command ? 1 : 0;
}

if (import.meta.main) {
  runCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
