#!/usr/bin/env bun
/**
 * @agile-agents/cli
 *
 * agile: the Agile Agents command-line interface — a thin client over
 * agiled's unix-socket JSON-RPC API (design/agile-agents-design.md §18
 * "Technical shape": "`agile` CLI: same client lib").
 *
 * `index.ts` is pure dispatch — one file per verb lives under `commands/`.
 * T122 deleted the `send`/`halt`/`resume`/`sync` verbs and the gate-decision
 * verbs with the subsystems behind them.
 */

import { resolveHomePaths } from '@agile-agents/daemon';
import { type ParsedArgs, parseArgs } from './args';
import { runAnswer } from './commands/answer';
import { runAttach, runDetach } from './commands/attach';
import {
  daemonStatusReport,
  formatDaemonStatus,
  runDaemonForeground,
  runDaemonStart,
  runDaemonStop,
} from './commands/daemon';
import { runBreakerClear, runGateList } from './commands/gate';
import { parseHookArgs, runHook } from './commands/hook';
import { runInbox } from './commands/inbox';
import { runCliInit } from './commands/init';
import { runLand } from './commands/land';
import { runQuestionAnswer, runQuestionList, runQuestionRaise } from './commands/question';
import { runRepoAdd, runRepoList } from './commands/repo';
import { runReview } from './commands/review';
import {
  runRulesAccept,
  runRulesAdd,
  runRulesList,
  runRulesReport,
  runRulesRetire,
  runRulesSeed,
  runRulesShow,
} from './commands/rules';
import { runStatus } from './commands/status';
import {
  runStreamArchive,
  runStreamClose,
  runStreamList,
  runStreamNew,
  runStreamSay,
  runStreamShow,
} from './commands/stream';
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
    '  stream new --title <t> --goal <g> [--parent <id>] [--repo <name>] [--target-branch <b>]',
    '  stream list [--all] [--status <s>] [--landed]   the stream tree (--all includes archived)',
    '  stream show <id>           the record plus the last 20 thread lines',
    '  stream close <id> [--note <text>]',
    '  stream archive <id>        hide from `stream list` (nothing moves on disk)',
    '  stream say <id> <text>     append one human line to the stream thread',
    '  rules list [--status proposed|accepted|retired] [--scope global|repo:<n>|stream:<id>]',
    '  rules show <id>            one rule: tier, scope, provenance, stats, examples',
    '  rules add --text "…" [--scope …] [--enforcement pattern|classifier|guidance] [--critical]',
    '                             [--question "…"] [--example "<action>::<true|false>"]…   (proposes it)',
    '  rules accept <id> [--by <who>]   accept a proposed rule (human-only, D4)',
    '  rules retire <id> [--by <who>]   retire a rule (a status change; nothing is deleted)',
    '  rules report [--days N]         per-rule fired/violated/routed counts and prune flags',
    '  rules seed --from PLAN-v1.md     import that plan\u2019s decisions as proposed rules',
    '  attach <stream> [--vendor v] [--model m] [--effort low|medium|high|max] [--role worker|reviewer]',
    '  review <stream> [--vendor v] [--model m] [--effort ...]   read-only reviewer session',
    '  detach <stream>            stop the live session on a stream',
    '  land <stream>              merge the stream branch into its target, close the stream, remove the worktree',
    '  daemon start               start agiled detached (pidfile + log in the state home)',
    '  daemon stop                stop the running agiled',
    '  daemon status              is agiled running? pid, port, socket, home',
    '  status                     daemon, streams and what is waiting on you',
    '  tail                       tail the event log (--follow, --stream, --kind, --session)',
    '  gate list                  list open HIL requests',
    '  inbox                      everything waiting on you, across all streams, oldest first',
    '  answer <id> <text|yes|no>  answer an inbox item: Q-… takes the answer text, HIL-… takes yes|no [note]',
    '  question list              list open questions (questions/ in the state home)',
    '  question raise --stream <id> --text <text> [--by <agent>]',
    '  question answer <id> --answer <text> [--by <agent>]',
    '  breaker clear <signal>',
    '  hook <event>               stdin JSON in, JSON out (e.g. hook pre-tool-use) [--fail-open] [--timeout <ms>, default 2000]',
    "  mcp --session <id> [--timeout <ms>, default 60000]   stdio MCP bridge to the daemon's agent.* verbs",
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
    console.log(runCliInit().message);
    return 0;
  }

  if (command === 'daemon') {
    try {
      if (sub === 'start') {
        // Internal: the detached child re-invokes itself with this flag and
        // *is* the daemon. Never typed by an operator.
        if (rest.includes('--foreground')) {
          await runDaemonForeground();
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
            stream: typeof args.options.stream === 'string' ? args.options.stream : undefined,
            kind: typeof args.options.kind === 'string' ? args.options.kind : undefined,
            session: typeof args.options.session === 'string' ? args.options.session : undefined,
          },
        });
      }

      case 'inbox':
        return await runInbox(socketPath, json);

      case 'answer':
        return await runAnswer(socketPath, parseArgs(rest.slice(1)), json);

      case 'gate':
        if (sub === 'list') return await runGateList(socketPath, json);
        console.error(usage());
        return 1;

      // T121: a question is raised on a stream and answering one is a reply
      // that reaches the waiting session (cockpit design §1.4).
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

      // T120: streams — the reshape's unit of work (cockpit design §2).
      case 'stream':
        if (sub === 'new') return await runStreamNew(socketPath, parseArgs(restArgv), json);
        if (sub === 'list') return await runStreamList(socketPath, parseArgs(restArgv), json);
        if (sub === 'show') return await runStreamShow(socketPath, parseArgs(restArgv), json);
        if (sub === 'close') return await runStreamClose(socketPath, parseArgs(restArgv), json);
        if (sub === 'archive') return await runStreamArchive(socketPath, parseArgs(restArgv), json);
        if (sub === 'say') return await runStreamSay(socketPath, parseArgs(restArgv), json);
        console.error(usage());
        return 1;

      // T140: rules — the system's memory of decisions (cockpit design §5).
      case 'rules': {
        const ruleArgs = parseArgs(restArgv);
        if (sub === 'list') return await runRulesList(socketPath, ruleArgs, json);
        if (sub === 'show') return await runRulesShow(socketPath, ruleArgs, json);
        if (sub === 'add') return await runRulesAdd(socketPath, ruleArgs, json, restArgv);
        if (sub === 'accept') return await runRulesAccept(socketPath, ruleArgs, json);
        if (sub === 'retire') return await runRulesRetire(socketPath, ruleArgs, json);
        if (sub === 'report') return await runRulesReport(socketPath, ruleArgs, json);
        if (sub === 'seed') return await runRulesSeed(socketPath, ruleArgs, json);
        console.error(usage());
        return 1;
      }

      // T130: an agent is a session attached to a stream (cockpit design §4).
      case 'attach':
        return await runAttach(socketPath, parseArgs(rest.slice(1)), json);

      case 'detach':
        return await runDetach(socketPath, parseArgs(rest.slice(1)), json);

      // T132: landing — the human's merge (cockpit design §8.2).
      case 'land':
        return await runLand(socketPath, parseArgs(rest.slice(1)), json);
      // T131: a reviewer is a second, read-only session (cockpit design §4.2).
      case 'review':
        return await runReview(socketPath, parseArgs(rest.slice(1)), json);

      case 'breaker':
        if (sub === 'clear') return await runBreakerClear(socketPath, parseArgs(restArgv), json);
        console.error(usage());
        return 1;

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
        const { session, timeoutMs, socketPath: explicitSocket } = parseMcpArgs(args);
        // Foreground process, same as `daemon start`: keep the event loop
        // alive for the life of the stdio MCP session.
        return await runCliMcp({
          socketPath: explicitSocket ?? socketPath,
          session,
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
