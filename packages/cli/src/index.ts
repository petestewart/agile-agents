#!/usr/bin/env bun
/**
 * @agile-agents/cli
 *
 * agile: the Agile Agents command-line interface — a thin client over
 * agiled's unix-socket JSON-RPC API (design/agile-agents-design.md §18
 * "Technical shape": "`agile` CLI: same client lib").
 *
 * T004 scope was `init` and `daemon start`; T008 (this file) adds
 * status/tail/send/approve/deny/note/delegate/resolve/halt/resume/hook/breaker and
 * makes every verb support `--json` alongside its human-readable output.
 * `index.ts` is pure dispatch — one file per verb lives under `commands/`.
 */

import { resolveHomePaths } from '@agile-agents/daemon';
import { type ParsedArgs, parseArgs } from './args';
import {
  daemonStatusReport,
  formatDaemonStatus,
  runDaemonForeground,
  runDaemonStart,
  runDaemonStop,
} from './commands/daemon';
import {
  runApprove,
  runBreakerClear,
  runDelegate,
  runDeny,
  runGateList,
  runGateNote,
  runResolve,
} from './commands/gate';
import { runHalt, runResume } from './commands/halt';
import { parseHookArgs, runHook } from './commands/hook';
import { runCliInit } from './commands/init';
import { runQuestionAnswer, runQuestionList, runQuestionRaise } from './commands/question';
import { runRepoAdd, runRepoList } from './commands/repo';
import { runSend } from './commands/send';
import { runStatus } from './commands/status';
import { runSync } from './commands/sync';
import { runTail } from './commands/tail';

export const PACKAGE_NAME = '@agile-agents/cli';

// Re-exported for the existing T004 test suite and any embedder that wants
// the pieces directly rather than going through `runCli`.
export { runCliInit };
export { runDaemonStart, runDaemonStop, runDaemonForeground, daemonStatusReport };
export type { CliInitResult } from './commands/init';

function usage(): string {
  return [
    'usage: agile <command> [options]',
    '',
    'commands:',
    '  init                       create the state home ($AGILE_HOME, default ~/.agile/) if missing',
    '  repo add <path> [--name <n>] [--protected a,b] [--target-branch <b>] [--vendor <v>]',
    '  repo list                  list registered repos',
    '  daemon start               start agiled detached (pidfile + log in the state home)',
    '  daemon stop                stop the running agiled',
    '  daemon status              is agiled running? pid, port, socket, home',
    '  status                     sprint/tickets/agents/spend',
    '  tail                       tail the event log (--follow, --ticket, --agent, --kind)',
    '  send                       send a bus message (--from --to --kind --priority --body [--ticket])',
    '  approve <hil-id>           approve a HIL request [--by <agent>] [--note <text>]',
    '  deny <hil-id>              deny a HIL request [--by <agent>] [--note <text>]',
    '  note <hil-id> --note <text>   answer a HIL request in free text (no decision; the EM decides)',
    '  delegate <hil-id> --to em|architect',
    '  resolve <hil-id> --decision approve|deny [--by <agent>] [--note <text>]',
    '  gate list                  list open HIL requests',
    '  question list              list open questions (board/questions/)',
    '  question raise --text <text> [--ticket <id>] [--by <agent>]',
    '  question answer <id> --answer <text> [--as reply|decision|ticket] [--edit <json>] [--ticket <id>]',
    '  halt [--scope <scope>] [--reason <text>] [--by <agent>]',
    '  resume <halt-id>',
    '  breaker clear <signal>',
    '  sync jira link <PROJECT> | unlink | status    two-way Jira sync (credentials from $JIRA_*)',
    '  hook <event>               stdin JSON in, JSON out (e.g. hook pre-tool-use) [--fail-closed] [--timeout <ms>, default 2000]',
    "  mcp --agent <id> [--ticket <id>] [--timeout <ms>, default 60000]   stdio MCP bridge to the daemon's tool.* RPC",
    '',
    'flags:',
    '  --json                     machine-readable output for any verb above',
  ].join('\n');
}

/**
 * T112 (D9): every client verb resolves the daemon from the **state home**,
 * never from a repo cwd — one long-lived daemon serves every registered
 * repo, so `agile status`/`agile tail` work from anywhere, including outside
 * any git repository.
 */
function socketPathFor(): string {
  return resolveHomePaths().socketPath;
}

function reportError(err: unknown): number {
  console.error(err instanceof Error ? err.message : String(err));
  return 1;
}

export async function runCli(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const json = argv.includes('--json');
  const rest = argv.filter((a) => a !== '--json');
  const [command, sub, ...restArgv] = rest;

  if (command === 'init') {
    console.log(runCliInit(cwd).message);
    return 0;
  }

  if (command === 'daemon') {
    try {
      if (sub === 'start') {
        // Internal: the detached child re-invokes itself with this flag and
        // *is* the daemon. Never typed by an operator.
        if (rest.includes('--foreground')) {
          await runDaemonForeground(cwd);
          return 0;
        }
        console.log(await runDaemonStart({ cwd }));
        return 0;
      }
      if (sub === 'stop') {
        console.log(await runDaemonStop());
        return 0;
      }
      if (sub === 'status') {
        const report = daemonStatusReport();
        if (json) console.log(JSON.stringify(report, null, 2));
        else console.log(formatDaemonStatus(report));
        return report.running ? 0 : 1;
      }
    } catch (err) {
      return reportError(err);
    }
    console.error(usage());
    return 1;
  }

  if (!command) {
    console.error(usage());
    return 0;
  }

  // Every remaining command is a client of the running daemon's socket.
  const socketPath = socketPathFor();

  try {
    switch (command) {
      case 'status':
        return await runStatus(socketPath, json);

      case 'tail': {
        const args = parseArgs(rest.slice(1));
        const eventsPath = resolveHomePaths().eventsPath;
        return await runTail({
          eventsPath,
          follow: args.options.follow !== undefined,
          json,
          filters: {
            ticket: typeof args.options.ticket === 'string' ? args.options.ticket : undefined,
            agent: typeof args.options.agent === 'string' ? args.options.agent : undefined,
            kind: typeof args.options.kind === 'string' ? args.options.kind : undefined,
          },
        });
      }

      case 'send':
        return await runSend(socketPath, parseArgs(rest.slice(1)), json);

      case 'approve':
        return await runApprove(socketPath, parseArgs(rest.slice(1)), json);

      case 'deny':
        return await runDeny(socketPath, parseArgs(rest.slice(1)), json);

      case 'note':
        return await runGateNote(socketPath, parseArgs(rest.slice(1)), json);

      case 'delegate':
        return await runDelegate(socketPath, parseArgs(rest.slice(1)), json);

      case 'resolve':
        return await runResolve(socketPath, parseArgs(rest.slice(1)), json);

      case 'gate':
        if (sub === 'list') return await runGateList(socketPath, json);
        console.error(usage());
        return 1;

      // T040 (§17 "Control room v2" → "Questions vs Decisions"): answering
      // one either replies to the raiser, records a `DEC-*` through the
      // oracle write guard, or applies a ticket edit.
      case 'question':
        if (sub === 'list') return await runQuestionList(socketPath, json);
        if (sub === 'answer') return await runQuestionAnswer(socketPath, parseArgs(restArgv), json);
        if (sub === 'raise') return await runQuestionRaise(socketPath, parseArgs(restArgv), json);
        console.error(usage());
        return 1;

      // T111: the repo registry in the state home (`repos.yaml`).
      case 'repo':
        if (sub === 'list') return await runRepoList(socketPath, json);
        if (sub === 'add') return await runRepoAdd(socketPath, parseArgs(restArgv), json, cwd);
        console.error(usage());
        return 1;

      case 'halt':
        return await runHalt(socketPath, parseArgs(rest.slice(1)), json);

      case 'resume':
        return await runResume(socketPath, parseArgs(rest.slice(1)), json);

      case 'breaker':
        if (sub === 'clear') return await runBreakerClear(socketPath, parseArgs(restArgv), json);
        console.error(usage());
        return 1;

      case 'sync':
        return await runSync(socketPath, parseArgs(rest.slice(1)), json);

      case 'hook': {
        const args: ParsedArgs = parseArgs(rest.slice(1));
        const { event, failClosed, timeoutMs } = parseHookArgs(args);
        return await runHook({ socketPath, event, failClosed, timeoutMs });
      }

      case 'mcp': {
        // Dynamic import (review finding, T011): `./commands/mcp` pulls in
        // `@modelcontextprotocol/sdk`, whose `server/stdio.js` transitively
        // loads a very large generated `types.js` — importing it eagerly at
        // module load delayed every other verb's process startup enough
        // that `agile hook`'s `readStdin()` (a bare `for await (const chunk
        // of process.stdin)`) sometimes attached its reader after the
        // piped stdin had already been silently dropped, losing the hook
        // payload. A static top-level import made every CLI invocation pay
        // that cost merely by importing this file; loading it only when the
        // `mcp` verb actually runs confines the cost to the one verb that
        // needs it.
        const { parseMcpArgs, runCliMcp } = await import('./commands/mcp');
        const args: ParsedArgs = parseArgs(rest.slice(1));
        const { agent, ticket, timeoutMs, socketPath: explicitSocket } = parseMcpArgs(args);
        // Foreground process, same as `daemon start`: keep the event loop
        // alive for the life of the stdio MCP session.
        return await runCliMcp({
          socketPath: explicitSocket ?? socketPath,
          agent,
          ticket,
          timeoutMs,
        });
      }

      default:
        console.error(usage());
        return 1;
    }
  } catch (err) {
    return reportError(err);
  }
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
