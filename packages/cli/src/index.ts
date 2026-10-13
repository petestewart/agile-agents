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
import { END_OF_OPTIONS, type ParsedArgs, parseArgs, parseKnownArgs } from './args';
import { runAnswer } from './commands/answer';
import { runAttach, runDetach } from './commands/attach';
import { runCodexInstallGate, runCodexStatus } from './commands/codex';
import {
  agileHomeProblem,
  daemonStatusReport,
  formatDaemonStatus,
  runDaemonForeground,
  runDaemonStart,
  runDaemonStop,
  withClassifierStatus,
} from './commands/daemon';
import { runDirectorSay } from './commands/director';
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
import {
  runPolicyChooseAgain,
  runPolicySet,
  runPolicyShow,
  runPolicyStepUp,
  runPolicyTry,
} from './commands/policy';
import { runProjectList, runProjectNew, runProjectSet, runProjectShow } from './commands/project';
import { runQuestionAnswer, runQuestionList, runQuestionRaise } from './commands/question';
import { runRepoAdd, runRepoList, runRepoSet } from './commands/repo';
import { runReview } from './commands/review';
import { runStatus } from './commands/status';
import {
  runStreamAddRepo,
  runStreamArchive,
  runStreamClose,
  runStreamImportChildren,
  runStreamLink,
  runStreamList,
  runStreamMove,
  runStreamNew,
  runStreamSay,
  runStreamSetAutonomy,
  runStreamShow,
  runStreamWait,
} from './commands/stream';
import { runDirectorTail, runNodeEvents, runTail } from './commands/tail';
import { runTrackerClear, runTrackerSet, runTrackerStatus } from './commands/tracker';
import { runVendors, runVendorsCheck, runVendorsInstall } from './commands/vendors';

export const PACKAGE_NAME = '@agile-agents/cli';

// Re-exported for the existing T004 test suite and any embedder that wants
// the pieces directly rather than going through `runCli`.
export { runCliInit };
export { runDaemonStart, runDaemonStop, runDaemonForeground, daemonStatusReport };
export type { CliInitResult } from './commands/init';

/**
 * The commands, one block each: a line starting `  <command>` and the deeper
 * indented lines under it. `agile <command> --help` prints that command's
 * blocks (T523), so a command's syntax is written once, here. The syntax
 * ends at the first run of two spaces; what follows is what it does.
 */
const COMMAND_LINES: readonly string[] = [
  '  init                       create the state home ($AGILE_HOME, default ~/.agile/) if missing',
  '  repo add <path> [--name <n>] [--protected a,b] [--target-branch <b>] [--vendor <v>]',
  '  repo list                  list registered repos',
  '  repo set <name> [--delivery direct|pr] [--auto-merge on|off] [--remote r] [--main-branch b] [--visibility public|private] [--project P-id]…',
  '  project new --name <n> [--repo a] [--repo b|a,b]   a project and its root stream',
  '  project list [--all]       projects (--all includes archived)',
  '  project show <id>',
  '  project set <id> [--name n] [--repo a,b] [--vendor v] [--model m] [--effort e] [--delivery direct|pr] [--auto-merge on|off] [--coordinator-autonomy|--director-autonomy advise|organise|run]',
  '                             [--tracker jira|linear|none] [--push-status on|off]',
  '                             [--status-map in_progress=<Name>,in_review=<Name>,done=<Name>]  (quote names with spaces; key= clears one)',
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
  '  node move <id> --parent <id|P-id>  move a node under another in its project (a P-id: its root)',
  '  node link <id> <KEY> [--system jira|linear] | --remove  link a tracker issue; its text becomes the goal',
  '  node import-children <id>        one linked child per issue in the linked epic (idempotent)',
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
  '  tail --director            the Director\u2019s thread (--follow)',
  '  director say "<line>"      a line to the Director; its reply lands on its thread',
  '  policy show [--project <P-id> | --node <id>]   model choice: each field, its value and where it comes from',
  '  policy set <field> <value> [--project <P-id> | --node <id>]   the home when neither; `inherit` clears it there',
  '  policy set vendor_order claude,codex   which vendor wins a tie inside a tier (`none`: no preference)',
  '  policy set vendor_order_by_role.<role> codex,claude   a role\u2019s own order (worker, coordinator, conversation, reviewer; `same` clears)',
  '                             fields: mode default|inherit|choose · quality 0-100 · presets vendor/model,…|any',
  '                             effort_ceiling low|medium|high|max · escalation start_cheap|strongest_first',
  '                             guidance "<text>" · weights clarity=2,stakes=3 · pinned_rules <JSON>',
  '  policy choose-again --node <id>   the node\u2019s next start picks its model afresh',
  '  policy step-up --node <id>   the node\u2019s next start runs one rung up its preset models (effort, then model)',
  '  policy try "<task text>" [--project <P-id> | --node <id>]   the chooser\u2019s scores and pick for a task; nothing starts',
  '  vendors                    each vendor\u2019s latest self-check: version, model, effort, usage, resume, rate limits',
  '  vendors check [vendor]     run the self-check (every installed vendor, or one): one session and one tiny prompt each',
  '  vendors install antigravity   download its pinned ACP server into the home (records the archive\u2019s SHA-256)',
  '  tracker status             Jira/Linear: base URL, email, whether each token is set (never the token)',
  '  tracker set jira|linear [--base-url <url>] [--email <addr>|--no-email] [--no-token]',
  '                             token read from stdin or a no-echo prompt, never an argument',
  '  tracker clear jira|linear  remove the token from config.yaml',
  '  gate list                  list open HIL requests',
  '  inbox                      everything waiting on you, across all streams, oldest first',
  '  answer <id> <text|yes|no>  answer an inbox item: Q-… takes the answer text, HIL-… takes yes|no [note]',
  '  question list              list open questions (questions/ in the state home)',
  '  question raise --stream <id> --text <text> [--by <agent>]',
  '  question answer <id> --answer <text> [--by <agent>]',
  '  breaker clear <signal>',
  '  codex install-gate         add the agile gate to Codex ($CODEX_HOME/hooks.json) and write its script; then trust it in Codex (/hooks)',
  '  codex status               whether Codex\u2019s gate is installed and trusted, per hook (never a hash)',
  '  hook <event>               stdin JSON in, JSON out (e.g. hook pre-tool-use) [--fail-open] [--timeout <ms>, default 2000]',
  '                             [--vendor codex [--home <dir>] [--repo <root>]…]',
  "  mcp --session <id> [--timeout <ms>, default 60000]   stdio MCP bridge to the daemon's agent.* verbs",
];

const FLAG_LINES: readonly string[] = [
  'flags:',
  '  --json                     machine-readable output for any verb above',
  '  --help, -h                 this text; `agile <command> --help` (or `agile help <command>`) for one command',
  '  --                         ends the options: every word after it is text, as typed',
  '                             (agile answer Q-1 -- use --no-verify then push)',
];

function usage(): string {
  return [
    'usage: agile <command> [options]',
    '',
    'commands:',
    ...COMMAND_LINES,
    '',
    ...FLAG_LINES,
  ].join('\n');
}

/** T523: `stream …` is `node`, `rules …` is `knowledge`, `land` is `deliver`. */
const ALIAS_OF: Readonly<Record<string, string>> = {
  stream: 'node',
  rules: 'knowledge',
  land: 'deliver',
};

function canonical(command: string): string {
  return ALIAS_OF[command] ?? command;
}

interface UsageBlock {
  command: string;
  /** The second word when it names a subcommand (`node say`), else undefined. */
  sub?: string;
  lines: string[];
}

const SUBCOMMAND = /^[a-z][a-z-]*$/;

export function usageBlocks(): UsageBlock[] {
  const blocks: UsageBlock[] = [];
  for (const line of COMMAND_LINES) {
    const last = blocks.at(-1);
    if (!/^ {2}\S/.test(line) && last !== undefined) {
      last.lines.push(line);
      continue;
    }
    const [command = '', second] = (line.trim().split(/ {2,}/)[0] ?? '').split(' ');
    blocks.push({
      command,
      ...(second !== undefined && SUBCOMMAND.test(second) ? { sub: second } : {}),
      lines: [line],
    });
  }
  return blocks;
}

/** The usage blocks of `command` (aliases included); with `sub`, only that subcommand's. */
function commandUsage(command: string, sub?: string): UsageBlock[] {
  const mine = usageBlocks().filter((b) => canonical(b.command) === canonical(command));
  if (sub === undefined) return mine;
  return mine.filter((b) => b.sub === sub);
}

function hasSubcommands(command: string): boolean {
  return commandUsage(command).some((b) => b.sub !== undefined);
}

function formatCommandUsage(blocks: UsageBlock[]): string {
  return [
    'usage:',
    ...blocks.flatMap((b) => b.lines),
    '',
    'flags: --json · --help · -- (every word after it is text); `agile --help` lists every command',
  ].join('\n');
}

const HELP_FLAGS = new Set(['--help', '-h']);

/**
 * T523 (CLI audit C2): what a help request asks about — `[]` for every
 * command, `[command]` or `[command, sub]` for one — or undefined when the
 * line asks for no help. `help`, `--help` and `-h` as the command; `--help`
 * anywhere before `--`; `-h` only where a subcommand or the first argument
 * goes, so `agile answer Q-1 ls -h shows sizes` keeps its `-h` as text.
 */
function helpRequest(rest: readonly string[]): string[] | undefined {
  const [first, second, third] = rest;
  if (first === undefined || HELP_FLAGS.has(first)) return [];
  if (first === 'help') return rest.slice(1, 3);
  const end = rest.indexOf(END_OF_OPTIONS);
  const options = end === -1 ? rest : rest.slice(0, end);
  const subs = hasSubcommands(first);
  const sub = subs && second !== undefined && !second.startsWith('-') ? [second] : [];
  if (second !== undefined && HELP_FLAGS.has(second)) return [first];
  if (subs && third !== undefined && HELP_FLAGS.has(third)) return [first, ...sub];
  if (options.includes('--help')) return [first, ...sub];
  return undefined;
}

/** Help goes to stdout and exits 0; help for a command that doesn't exist is a usage error. */
function printHelp(topic: readonly string[]): number {
  const [command, sub] = topic;
  if (command === undefined) {
    console.log(usage());
    return 0;
  }
  const blocks = commandUsage(command, sub);
  if (blocks.length === 0) return usageError(command, sub);
  console.log(formatCommandUsage(blocks));
  return 0;
}

/**
 * A line no command matches: what was wrong, then the usage that fits (the
 * command's own when it exists), on stderr, exit 1.
 */
function usageError(command: string | undefined, sub?: string): number {
  const mine = command === undefined ? [] : commandUsage(command);
  if (command !== undefined && mine.length === 0) {
    console.error(`agile: unknown command ${command}`);
    console.error(usage());
    return 1;
  }
  if (command !== undefined) {
    console.error(
      sub === undefined
        ? `agile ${command}: name a subcommand`
        : `agile ${command}: unknown subcommand ${sub}`,
    );
    console.error(formatCommandUsage(mine));
    return 1;
  }
  console.error(usage());
  return 1;
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

/**
 * T523 (CLI audit C3): a free-text verb's own options. Every other word is
 * its text, kept as typed; any other `--word` is refused by name.
 */
function textArgs(argv: string[], verb: string, values: readonly string[] = []): ParsedArgs {
  return parseKnownArgs(argv, { verb, values });
}

/** T523: an option-carried sentence (`--text`, `--answer`, `--note`): `--` can't keep it, quotes can. */
function sentenceOptionArgs(argv: string[], verb: string, values: readonly string[]): ParsedArgs {
  return parseKnownArgs(argv, {
    verb,
    values,
    hint: 'If it is part of the text, quote the whole text',
  });
}

export async function runCli(argv: string[], cwd: string = process.cwd()): Promise<number> {
  // T523: `--json` is a flag only before `--`; after it, it is text like any word.
  const end = argv.indexOf(END_OF_OPTIONS);
  const head = end === -1 ? argv : argv.slice(0, end);
  const json = head.includes('--json');
  const rest = [...head.filter((a) => a !== '--json'), ...(end === -1 ? [] : argv.slice(end))];
  const [command, sub, ...restArgv] = rest;

  // T523 (C2): help is an answer, not a usage error: stdout, exit 0. Before
  // anything runs, so `agile init --help` creates nothing.
  const help = helpRequest(rest);
  if (help !== undefined) return printHelp(help);

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
    return usageError(command, sub);
  }

  // Every remaining command is a client of the running daemon's socket.
  const socketPath = socketPathFor();

  try {
    switch (command) {
      case 'status':
        return await runStatus(socketPath, json);

      case 'tail': {
        const args = parseArgs(rest.slice(1));
        // T300: the Director's thread.
        if (args.options.director !== undefined) {
          return await runDirectorTail({
            home: resolveHomePaths().home,
            follow: args.options.follow !== undefined,
            json,
          });
        }
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
        return await runAnswer(socketPath, textArgs(rest.slice(1), 'agile answer', ['by']), json);

      case 'gate':
        if (sub === 'list') return await runGateList(socketPath, json);
        return usageError(command, sub);

      // T121: a question is raised on a stream and answering one is a reply
      // that reaches the waiting session (cockpit design §1.4).
      case 'question':
        if (sub === 'list') return await runQuestionList(socketPath, json);
        if (sub === 'answer') {
          const args = sentenceOptionArgs(restArgv, 'agile question answer', ['answer', 'by']);
          return await runQuestionAnswer(socketPath, args, json);
        }
        if (sub === 'raise') {
          const args = sentenceOptionArgs(restArgv, 'agile question raise', [
            'stream',
            'text',
            'by',
          ]);
          return await runQuestionRaise(socketPath, args, json);
        }
        return usageError(command, sub);

      // T111: the repo registry in the state home (`repos.yaml`).
      case 'repo':
        if (sub === 'list') return await runRepoList(socketPath, json);
        if (sub === 'add') return await runRepoAdd(socketPath, parseArgs(restArgv), json, cwd);
        if (sub === 'set') return await runRepoSet(socketPath, parseArgs(restArgv), json);
        return usageError(command, sub);

      // T200: projects — a record plus a root stream (projects-design §14.1).
      case 'director':
        if (sub === 'say') {
          return await runDirectorSay(socketPath, textArgs(restArgv, 'agile director say'), json);
        }
        return usageError(command, sub);

      // T326 (D31): tracker settings; the token never travels as an argument.
      case 'tracker': {
        if (sub === 'status') return await runTrackerStatus(socketPath, json);
        if (sub === 'set') return await runTrackerSet(socketPath, parseArgs(restArgv), json);
        if (sub === 'clear') return await runTrackerClear(socketPath, parseArgs(restArgv), json);
        return usageError(command, sub);
      }

      // T512: Codex's user-level gate.
      case 'codex': {
        if (sub === 'install-gate') return await runCodexInstallGate(socketPath, json);
        if (sub === 'status') return await runCodexStatus(socketPath, json);
        return usageError(command, sub);
      }

      // T489 (D58): the vendor self-check.
      case 'vendors': {
        if (sub === undefined) return await runVendors(socketPath, json);
        if (sub === 'check') return await runVendorsCheck(socketPath, restArgv[0], json);
        if (sub === 'install') return await runVendorsInstall(socketPath, restArgv[0], json);
        return usageError(command, sub);
      }

      // T482: model choice (design/model-routing.md §4).
      case 'policy': {
        const policyArgs = parseArgs(restArgv);
        if (sub === 'show') return await runPolicyShow(socketPath, policyArgs, json);
        // T523: a value (guidance) and a task are free text.
        if (sub === 'set' || sub === 'try') {
          const args = textArgs(restArgv, `agile policy ${sub}`, ['project', 'node']);
          if (sub === 'set') return await runPolicySet(socketPath, args, json);
          return await runPolicyTry(socketPath, args, json);
        }
        if (sub === 'choose-again') return await runPolicyChooseAgain(socketPath, policyArgs, json);
        if (sub === 'step-up') return await runPolicyStepUp(socketPath, policyArgs, json);
        return usageError(command, sub);
      }

      case 'project': {
        const projectArgs = parseArgs(restArgv);
        if (sub === 'new') return await runProjectNew(socketPath, projectArgs, json);
        if (sub === 'list') return await runProjectList(socketPath, projectArgs, json);
        if (sub === 'show') return await runProjectShow(socketPath, projectArgs, json);
        if (sub === 'set') return await runProjectSet(socketPath, projectArgs, json);
        return usageError(command, sub);
      }

      // T120: streams — the reshape's unit of work (cockpit design §2).
      // T201: `node` is the verb; `stream` stays as an alias.
      case 'node':
      case 'stream':
        if (sub === 'new') return await runStreamNew(socketPath, parseArgs(restArgv), json);
        if (sub === 'list') return await runStreamList(socketPath, parseArgs(restArgv), json);
        if (sub === 'show') return await runStreamShow(socketPath, parseArgs(restArgv), json);
        if (sub === 'close') {
          const args = sentenceOptionArgs(restArgv, `agile ${command} close`, ['note']);
          return await runStreamClose(socketPath, args, json);
        }
        if (sub === 'archive') return await runStreamArchive(socketPath, parseArgs(restArgv), json);
        if (sub === 'say') {
          return await runStreamSay(socketPath, textArgs(restArgv, `agile ${command} say`), json);
        }
        if (sub === 'wait') return await runStreamWait(socketPath, parseArgs(restArgv), json);
        if (sub === 'move') return await runStreamMove(socketPath, parseArgs(restArgv), json);
        if (sub === 'link') return await runStreamLink(socketPath, parseArgs(restArgv), json);
        if (sub === 'import-children') {
          return await runStreamImportChildren(socketPath, parseArgs(restArgv), json);
        }
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
        return usageError(command, sub);

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
        return usageError(command, sub);
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
        return usageError(command, sub);

      case 'hook': {
        const args: ParsedArgs = parseArgs(rest.slice(1));
        const { event, failClosed, timeoutMs, vendor, repos, home } = parseHookArgs(args);
        return await runHook({
          socketPath,
          event,
          failClosed,
          timeoutMs,
          ...(vendor !== undefined ? { vendor } : {}),
          ...(repos !== undefined ? { repos } : {}),
          ...(home !== undefined ? { home } : {}),
        });
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
        return usageError(command, sub);
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
