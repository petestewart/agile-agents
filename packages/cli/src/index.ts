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
  agileHomeProblem,
  daemonStatusReport,
  formatDaemonStatus,
  runDaemonForeground,
  runDaemonStart,
  runDaemonStop,
  withClassifierStatus,
} from './commands/daemon';
import { runBreakerClear, runGateList } from './commands/gate';
import { parseHookArgs, runHook } from './commands/hook';
import { runInbox } from './commands/inbox';
import { runCliInit } from './commands/init';
import {
  runKnowledgeAccept,
  runKnowledgeAdd,
  runKnowledgeEdit,
  runKnowledgeList,
  runKnowledgeReport,
  runKnowledgeRetire,
  runKnowledgeShow,
  runKnowledgeTest,
} from './commands/knowledge';
import { runLand } from './commands/land';
import { runProjectList, runProjectNew, runProjectSet, runProjectShow } from './commands/project';
import { runQuestionAnswer, runQuestionList, runQuestionRaise } from './commands/question';
import { runRepoAdd, runRepoList, runRepoSet } from './commands/repo';
import { runReview } from './commands/review';
import { runStatus } from './commands/status';
import {
  runStreamAddRepo,
  runStreamArchive,
  runStreamClose,
  runStreamList,
  runStreamNew,
  runStreamSay,
  runStreamSetAutonomy,
  runStreamShow,
  runStreamWait,
} from './commands/stream';
import { runNodeEvents, runTail } from './commands/tail';

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
    '  repo set <name> [--delivery direct|pr] [--auto-merge on|off] [--remote r] [--main-branch b] [--visibility public|private] [--project P-id]…',
    '  project new --name <n> [--repo a] [--repo b|a,b]   a project and its root stream',
    '  project list [--all]       projects (--all includes archived)',
    '  project show <id>',
    '  project set <id> [--name n] [--repo a,b] [--vendor v] [--model m] [--effort e] [--delivery direct|pr] [--auto-merge on|off] [--coordinator-autonomy|--director-autonomy advise|organise|run]',
    '  node new --title <t> --goal <g> --project <P-id> [--parent <id>] [--repo <name>] [--label l]… [--no-start]',
    "                             [--helper-of <id>]: a same-repo helper off that node's branch, merged back into it",
    "                             starts the node's agent unless --no-start",
    '                             (--project may be left out when --parent names a node in a project)',
    '  node list [--all] [--status <s>] [--landed] [--project <P-id>] [--parent <id>]',
    '                             the tree; with --project/--parent a flat list with each role',
    '  node show <id>             the record, its role and the last 20 thread lines',
    '  node close <id> [--note <text>]',
    '  node archive <id>          hide from `node list` (nothing moves on disk)',
    '  node say <id> <text>       append one human line to the node thread',
    '  node add-repo <id> <repo>  + Repo in place: conversation → work, work → coordinating with parts',
    '  node switch-repo <id> <repo>  move a work node with nothing committed to another repo',
    '  node wait <id> --on <id>… [--remove]  hold delivery until each --on node is merged',
    '  node set <id> --autonomy advise|organise|run|inherit  this node\u2019s coordinator autonomy',
    '  stream …                   alias of `node`',
    '  knowledge list [--status proposed|accepted|retired] [--scope global|repo:<n>|project:<id>|subtree:<id>]',
    '  knowledge show <id>        one item: kind, scope, paths, enforcement, check, source, stats, examples',
    '  knowledge add --text "…" [--name <label>] [--kind standard|architecture|decision]',
    '                             [--scope global|repo:<name>|project:<id>|subtree:<node>] [--path <glob>]…',
    '                             [--enforcement tell|action|ship|review] [--critical]',
    '                             [--question "…"] [--criteria-true "…" --criteria-false "…"]',
    '                             [--example "<action>::<true|false>"]…   (action/ship classifier check; at most 20)',
    '                             [--pattern no_push|no_push_protected|path_deny|command_deny [--pattern-arg …]…]  (action only)',
    '                             proposes it; accepting an action/ship classifier check needs two examples',
    '  knowledge edit <id> [--text …] [--name …] [--kind …] [--scope …] [--path …]… [--enforcement …]',
    '                             [--pattern …] [--question …] [--criteria-true … --criteria-false …]',
    '                             [--example "a::true" …]   (--example replaces the list)',
    '  knowledge accept <id> [--by <who>]   accept a proposed item (human-only, D4)',
    '  knowledge retire <id> [--by <who>]   retire an item (a status change; nothing is deleted)',
    '  knowledge report [--days N]     per-item fired/violated/routed counts and prune flags',
    '  knowledge test [id]             run accepted classifier checks\u2019 examples through the classifier',
    '  rules …                    alias of `knowledge` (--enforcement pattern|classifier|guidance [--stage …] still parse)',
    '  attach <stream> [--vendor v] [--model m] [--effort low|medium|high|max] [--role worker|reviewer]',
    '  resolve <stream> [--vendor v] [--model m] [--effort ...]   a worker that fixes the last land conflict',
    '  review <stream> [--vendor v] [--model m] [--effort ...]   read-only reviewer session',
    '  detach <stream>            stop the live session on a stream',
    '  deliver <stream>           ship-check, then merge the branch into main; close the stream, remove the worktree',
    '  land <stream>              alias of deliver',
    '  daemon start               start agiled detached (pidfile + log in the state home)',
    '  daemon stop                stop the running agiled',
    '  daemon status              is agiled running? pid, port, socket, home, classifier key loaded?',
    '  status                     daemon, streams and what is waiting on you',
    '  tail                       tail the event log (--follow, --stream, --kind, --session)',
    '  tail --node <id> --events  the node\u2019s routed events: reason, delivery status, session or digest (--follow)',
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

  // T210: a non-directory AGILE_HOME is refused up front, one line.
  const homeProblem = agileHomeProblem();
  if (homeProblem) {
    console.error(homeProblem);
    return 1;
  }

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
        const report = await withClassifierStatus(daemonStatusReport());
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
        // T245: a node's routed events (its Activity), not the audit log.
        if (args.options.events !== undefined) {
          if (typeof args.options.node !== 'string') {
            console.error('agile tail --events needs --node <id>');
            return 1;
          }
          return await runNodeEvents({
            home: resolveHomePaths().home,
            node: args.options.node,
            follow: args.options.follow !== undefined,
            json,
          });
        }
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
        if (sub === 'set') return await runRepoSet(socketPath, parseArgs(restArgv), json);
        console.error(usage());
        return 1;

      // T200: projects — a record plus a root stream (projects-design §14.1).
      case 'project': {
        const projectArgs = parseArgs(restArgv);
        if (sub === 'new') return await runProjectNew(socketPath, projectArgs, json);
        if (sub === 'list') return await runProjectList(socketPath, projectArgs, json);
        if (sub === 'show') return await runProjectShow(socketPath, projectArgs, json);
        if (sub === 'set') return await runProjectSet(socketPath, projectArgs, json);
        console.error(usage());
        return 1;
      }

      // T120: streams — the reshape's unit of work (cockpit design §2).
      // T201: `node` is the verb; `stream` stays as an alias.
      case 'node':
      case 'stream':
        if (sub === 'new') return await runStreamNew(socketPath, parseArgs(restArgv), json);
        if (sub === 'list') return await runStreamList(socketPath, parseArgs(restArgv), json);
        if (sub === 'show') return await runStreamShow(socketPath, parseArgs(restArgv), json);
        if (sub === 'close') return await runStreamClose(socketPath, parseArgs(restArgv), json);
        if (sub === 'archive') return await runStreamArchive(socketPath, parseArgs(restArgv), json);
        if (sub === 'say') return await runStreamSay(socketPath, parseArgs(restArgv), json);
        if (sub === 'wait') return await runStreamWait(socketPath, parseArgs(restArgv), json);
        if (sub === 'set') {
          return await runStreamSetAutonomy(socketPath, parseArgs(restArgv), json);
        }
        if (sub === 'add-repo' || sub === 'switch-repo') {
          return await runStreamAddRepo(
            socketPath,
            parseArgs(restArgv),
            json,
            sub === 'switch-repo',
          );
        }
        console.error(usage());
        return 1;

      // T260: knowledge items (projects-design §5, §6); `rules` is the old name.
      case 'knowledge':
      case 'rules': {
        const ruleArgs = parseArgs(restArgv);
        if (sub === 'list') return await runKnowledgeList(socketPath, ruleArgs, json);
        if (sub === 'show') return await runKnowledgeShow(socketPath, ruleArgs, json);
        if (sub === 'add') return await runKnowledgeAdd(socketPath, ruleArgs, json, restArgv);
        if (sub === 'edit') return await runKnowledgeEdit(socketPath, ruleArgs, json, restArgv);
        if (sub === 'accept') return await runKnowledgeAccept(socketPath, ruleArgs, json);
        if (sub === 'retire') return await runKnowledgeRetire(socketPath, ruleArgs, json);
        if (sub === 'report') return await runKnowledgeReport(socketPath, ruleArgs, json);
        if (sub === 'test') return await runKnowledgeTest(socketPath, ruleArgs, json);
        console.error(usage());
        return 1;
      }

      // T130: an agent is a session attached to a stream (cockpit design §4).
      case 'attach':
        return await runAttach(socketPath, parseArgs(rest.slice(1)), json);

      case 'resolve':
        return await runAttach(socketPath, parseArgs(rest.slice(1)), json, true);

      case 'detach':
        return await runDetach(socketPath, parseArgs(rest.slice(1)), json);

      // T132: landing — the human's merge (cockpit design §8.2).
      case 'deliver':
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
