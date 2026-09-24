/**
 * `agile knowledge list|show|add|edit|accept|retire|report|test` (T260) —
 * the CLI over the daemon's `knowledge.*` RPC (projects-design §5, §6,
 * §14.3). `agile rules …` is the same commands under their old name. Thin,
 * like `stream.ts`: parse argv, call one method, print human or `--json`.
 *
 * Every write here is the human's: the daemon stamps the `human` principal
 * at the RPC edge and never accepts one from params (§2.2), so there is no
 * `--as` flag and never will be one on this path. An agent proposes
 * through its `propose_knowledge` verb.
 */

import type { RuleEvalPlan, RuleEvalReport, RuleReport, RuleReportRow } from '@agile-agents/daemon';
import {
  KNOWLEDGE_ENFORCEMENTS,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_STATUSES,
  type KnowledgeCheck,
  type KnowledgeEnforcement,
  type KnowledgeItem,
  type KnowledgeKind,
  type KnowledgeStatus,
  LEGACY_RULE_ENFORCEMENTS,
  LEGACY_RULE_STAGES,
  type LegacyRuleEnforcement,
  type LegacyRuleStage,
  type RuleCriteria,
  type RuleExample,
  type RulePattern,
  classifierCheckOf,
  classifierQuestion,
  examplesOf,
  formatEnforcement,
  formatKnowledgeScope,
  formatRulePattern,
  legacyEnforcement,
  parseKnowledgeScope,
  patternOf,
  rulePatternFromArgs,
} from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { hasFlag, optionalList, optionalString, requireOption, requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson, printTable } from '../format';

/**
 * `id name kind status enforcement scope text` — the table of `agile
 * knowledge list`. `name` is the short label (`--name`, or a built-in's
 * §5.4 name) and `-` for an item without one.
 */
export const KNOWLEDGE_HEADERS = ['id', 'name', 'kind', 'status', 'enforcement', 'scope', 'text'];

/** The `enforcement` cell carries the check and a `!` for a critical item (`formatEnforcement`). */
export function knowledgeRows(items: readonly KnowledgeItem[]): string[][] {
  return items.map((item) => [
    item.id,
    item.name ?? '-',
    item.kind,
    item.status,
    formatEnforcement(item),
    formatKnowledgeScope(item.scope),
    item.text,
  ]);
}

/** The `agile knowledge show` field block. */
export function showFields(item: KnowledgeItem): Array<[string, string]> {
  const fields: Array<[string, string]> = [
    ['id', item.id],
    ['name', item.name ?? '-'],
    ['kind', item.kind],
    ['status', item.status],
    ['text', item.text],
    ['scope', formatKnowledgeScope(item.scope)],
    ['paths', item.paths !== undefined && item.paths.length > 0 ? item.paths.join(', ') : 'all'],
    ['enforcement', item.enforcement],
    ['critical', String(item.critical)],
  ];
  const pattern = patternOf(item);
  if (pattern !== undefined) fields.push(['check', `pattern ${formatRulePattern(pattern)}`]);
  const classifier = classifierCheckOf(item);
  if (classifier !== undefined) {
    fields.push(['check', 'classifier'], ['question', classifierQuestion(item)]);
    if (classifier.criteria !== undefined) {
      fields.push(
        ['criteria true', classifier.criteria.true],
        ['criteria false', classifier.criteria.false],
      );
    }
  }
  fields.push(
    ['source', formatSource(item)],
    [
      'stats',
      `fired ${item.stats.fired} · violated ${item.stats.violated} · routed ${item.stats.routed}${item.stats.last_fired_at ? ` · last ${item.stats.last_fired_at}` : ''}`,
    ],
    ['created_at', item.created_at],
    [
      'decided',
      item.decided_at === undefined ? '-' : `${item.decided_at} by ${item.decided_by ?? '-'}`,
    ],
  );
  return fields;
}

function formatSource(item: KnowledgeItem): string {
  const { by, node, session, finding } = item.source;
  const parts: string[] = [by];
  if (node !== undefined) parts.push(`node ${node}`);
  if (session !== undefined) parts.push(`session ${session}`);
  if (finding !== undefined) parts.push(`finding ${finding}`);
  return parts.join(' · ');
}

function optionalChoice<T extends string>(
  args: ParsedArgs,
  name: string,
  choices: readonly T[],
): T | undefined {
  const value = optionalString(args.options, name);
  if (value === undefined) return undefined;
  if (!(choices as readonly string[]).includes(value)) {
    throw new Error(`--${name} must be one of ${choices.join(', ')}`);
  }
  return value as T;
}

/**
 * `--enforcement tell|action|ship|review` (§6). The old tiers still parse,
 * so `agile rules add --enforcement classifier --stage diff` keeps working:
 * they map as the home migration maps them (`legacyEnforcement`).
 */
export function parseEnforcement(args: ParsedArgs): KnowledgeEnforcement | undefined {
  const value = optionalString(args.options, 'enforcement');
  const stage = optionalChoice<LegacyRuleStage>(args, 'stage', LEGACY_RULE_STAGES);
  if (value === undefined) {
    if (stage !== undefined) throw new Error('--stage needs --enforcement classifier');
    return undefined;
  }
  if ((KNOWLEDGE_ENFORCEMENTS as readonly string[]).includes(value)) {
    if (stage !== undefined) throw new Error(`--stage applies to the old tiers only, not ${value}`);
    return value as KnowledgeEnforcement;
  }
  if ((LEGACY_RULE_ENFORCEMENTS as readonly string[]).includes(value)) {
    return legacyEnforcement(value as LegacyRuleEnforcement, stage);
  }
  throw new Error(
    `--enforcement must be one of ${KNOWLEDGE_ENFORCEMENTS.join(', ')} (or the old ${LEGACY_RULE_ENFORCEMENTS.join(', ')})`,
  );
}

/**
 * `--example "action::violates"`, repeatable. `::` rather than `:` because
 * an example action is usually a command (`git push origin main`) and a
 * single colon is common inside one.
 */
export function parseExample(spec: string): RuleExample {
  const separator = spec.lastIndexOf('::');
  if (separator === -1) {
    throw new Error(`--example must look like "<action>::<true|false>" (got "${spec}")`);
  }
  const action = spec.slice(0, separator).trim();
  const violates = spec.slice(separator + 2).trim();
  if (action.length === 0 || (violates !== 'true' && violates !== 'false')) {
    throw new Error(`--example must look like "<action>::<true|false>" (got "${spec}")`);
  }
  return { action, violates: violates === 'true' };
}

/**
 * Every `--example` on the command line, in order. Not `optionalList`: an
 * example action may itself contain a comma.
 */
export function parseExamples(argv: readonly string[]): RuleExample[] {
  const examples: RuleExample[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--example') continue;
    const spec = argv[i + 1];
    if (spec === undefined || spec.startsWith('--')) {
      throw new Error('--example needs a value: "<action>::<true|false>"');
    }
    examples.push(parseExample(spec));
    i++;
  }
  return examples;
}

/**
 * T167: `--pattern <kind> [--pattern-arg <value>]…` — an action item's
 * deterministic check. `--pattern-arg` repeats (a glob for `path_deny`, a
 * token pattern for `command_deny`); a `--pattern-arg` with no `--pattern`
 * is refused rather than ignored.
 */
export function parsePattern(args: ParsedArgs, argv: readonly string[]): RulePattern | undefined {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--pattern-arg') continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('--pattern-arg needs a value');
    }
    values.push(value);
    i++;
  }
  const kind = args.options.pattern;
  if (kind === undefined) {
    if (values.length > 0) throw new Error('--pattern-arg needs --pattern <kind>');
    return undefined;
  }
  if (kind === true) throw new Error('--pattern needs a kind');
  return rulePatternFromArgs(kind, values);
}

/**
 * T156: `--criteria-true "…" --criteria-false "…"` — the classifier
 * check's criteria (D14), both or neither.
 */
export function parseCriteria(args: ParsedArgs): RuleCriteria | undefined {
  const yes = optionalString(args.options, 'criteria-true');
  const no = optionalString(args.options, 'criteria-false');
  if (yes === undefined && no === undefined) return undefined;
  if (yes === undefined || no === undefined) {
    throw new Error('--criteria-true and --criteria-false must be given together');
  }
  return { true: yes, false: no };
}

/** The check-shaping flags, as given (undefined when absent). */
interface CheckFlags {
  pattern?: RulePattern;
  question?: string;
  criteria?: RuleCriteria;
  examples: RuleExample[];
}

function checkFlags(args: ParsedArgs, argv: readonly string[]): CheckFlags {
  const question = optionalString(args.options, 'question');
  const criteria = parseCriteria(args);
  const pattern = parsePattern(args, argv);
  return {
    examples: parseExamples(argv),
    ...(question !== undefined ? { question } : {}),
    ...(criteria !== undefined ? { criteria } : {}),
    ...(pattern !== undefined ? { pattern } : {}),
  };
}

/** The old `--enforcement pattern` promised a pattern: without `--pattern` it is refused, as before. */
function assertLegacyPattern(args: ParsedArgs, flags: CheckFlags): void {
  if (optionalString(args.options, 'enforcement') === 'pattern' && flags.pattern === undefined) {
    throw new Error(
      'a pattern rule needs a pattern: give --pattern no_push|no_push_protected|path_deny|command_deny [--pattern-arg …]',
    );
  }
}

function givesClassifier(flags: CheckFlags): boolean {
  return flags.question !== undefined || flags.criteria !== undefined || flags.examples.length > 0;
}

/**
 * §14.3's `check` from the flags: a pattern for an `action` item, else a
 * classifier question with its examples for `action`/`ship`; `tell` and
 * `review` take none. `current` is the item being edited: flags not given
 * keep its question, criteria and examples.
 */
export function buildCheck(
  enforcement: KnowledgeEnforcement,
  flags: CheckFlags,
  current?: KnowledgeCheck,
): KnowledgeCheck | undefined {
  if (enforcement === 'tell' || enforcement === 'review') {
    if (flags.pattern !== undefined || givesClassifier(flags)) {
      throw new Error(
        `a ${enforcement} item carries no check: --pattern, --question, --criteria-* and --example need --enforcement action or ship`,
      );
    }
    return undefined;
  }
  if (flags.pattern !== undefined) {
    if (enforcement !== 'action') throw new Error('--pattern is an action check only');
    if (givesClassifier(flags)) {
      throw new Error('--pattern and --question/--criteria-*/--example are two different checks');
    }
    return { by: 'pattern', pattern: flags.pattern };
  }
  if (current?.by === 'pattern' && !givesClassifier(flags)) {
    if (enforcement !== 'action') throw new Error('a pattern check is an action check only');
    return current;
  }
  const before = current?.by === 'classifier' ? current : undefined;
  const question = flags.question ?? before?.question;
  const criteria = flags.criteria ?? before?.criteria;
  return {
    by: 'classifier',
    ...(question !== undefined ? { question } : {}),
    ...(criteria !== undefined ? { criteria } : {}),
    examples: flags.examples.length > 0 ? flags.examples : (before?.examples ?? []),
  };
}

export async function runKnowledgeList(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const status = optionalChoice<KnowledgeStatus>(args, 'status', KNOWLEDGE_STATUSES);
  const scope = optionalString(args.options, 'scope');
  const result = await callRpc<{ items: KnowledgeItem[] }>(socketPath, 'knowledge.list', {
    ...(status !== undefined ? { status } : {}),
    ...(scope !== undefined ? { scope: formatKnowledgeScope(parseKnowledgeScope(scope)) } : {}),
  });
  if (json) {
    printJson(result);
    return 0;
  }
  if (result.items.length === 0) {
    console.log('knowledge: (none)');
    return 0;
  }
  printTable(KNOWLEDGE_HEADERS, knowledgeRows(result.items));
  return 0;
}

export async function runKnowledgeShow(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'knowledge-id');
  const item = await callRpc<KnowledgeItem>(socketPath, 'knowledge.get', { id });
  if (json) printJson(item);
  else {
    printFields(showFields(item));
    const examples = examplesOf(item);
    if (examples.length > 0) {
      console.log('');
      console.log(`examples (${examples.length}):`);
      for (const example of examples) {
        console.log(`  ${example.violates ? 'violates' : 'allowed '}  ${example.action}`);
      }
    }
  }
  return 0;
}

/**
 * `agile knowledge add` writes a **proposal**, like every other create:
 * the human's authority lives in `agile knowledge accept`, a second,
 * explicit act. `--enforcement` defaults to `tell`, or to `action` when
 * `--pattern` is given; `--kind` defaults to `standard`.
 */
export async function runKnowledgeAdd(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
  argv: readonly string[] = [],
): Promise<number> {
  const text = requireOption(args.options, 'text');
  const name = optionalString(args.options, 'name');
  const kind = optionalChoice<KnowledgeKind>(args, 'kind', KNOWLEDGE_KINDS);
  const scopeText = optionalString(args.options, 'scope');
  const paths = optionalList(args, 'path');
  const flags = checkFlags(args, argv);
  assertLegacyPattern(args, flags);
  const enforcement = parseEnforcement(args) ?? (flags.pattern !== undefined ? 'action' : 'tell');
  const check = buildCheck(enforcement, flags);
  const item = await callRpc<KnowledgeItem>(socketPath, 'knowledge.create', {
    text,
    ...(name !== undefined ? { name } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(scopeText !== undefined ? { scope: parseKnowledgeScope(scopeText) } : {}),
    ...(paths !== undefined ? { paths } : {}),
    enforcement,
    ...(check !== undefined ? { check } : {}),
    ...(hasFlag(args.options, 'critical') ? { critical: true } : {}),
  });
  if (json) printJson(item);
  else {
    console.log(
      `agile knowledge add: ${item.id}${item.name !== undefined ? ` (${item.name})` : ''} proposed · ${item.kind} · ${formatEnforcement(item)} · ${formatKnowledgeScope(item.scope)}`,
    );
  }
  return 0;
}

/**
 * `agile knowledge edit <id> [--text …] [--name …] [--kind …] [--scope …]
 * [--path …]… [--enforcement …] [--pattern …] [--question …] [--criteria-*
 * …] [--example …]…` — edit-then-accept over `knowledge.update`. Only the
 * flags given change; `--example` replaces the example list, and a check
 * flag given alone keeps the rest of the current check.
 */
export async function runKnowledgeEdit(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
  argv: readonly string[] = [],
): Promise<number> {
  const id = requirePositional(args, 0, 'knowledge-id');
  const text = optionalString(args.options, 'text');
  const name = optionalString(args.options, 'name');
  const kind = optionalChoice<KnowledgeKind>(args, 'kind', KNOWLEDGE_KINDS);
  const scopeText = optionalString(args.options, 'scope');
  const paths = optionalList(args, 'path');
  const enforcement = parseEnforcement(args);
  const flags = checkFlags(args, argv);
  assertLegacyPattern(args, flags);
  const touchesCheck =
    enforcement !== undefined || flags.pattern !== undefined || givesClassifier(flags);
  let check: KnowledgeCheck | undefined;
  let nextEnforcement = enforcement;
  if (touchesCheck) {
    const current = await callRpc<KnowledgeItem>(socketPath, 'knowledge.get', { id });
    nextEnforcement = enforcement ?? (flags.pattern !== undefined ? 'action' : current.enforcement);
    check = buildCheck(nextEnforcement, flags, current.check);
  }
  const patch = {
    ...(text !== undefined ? { text } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(scopeText !== undefined ? { scope: parseKnowledgeScope(scopeText) } : {}),
    ...(paths !== undefined ? { paths } : {}),
    ...(nextEnforcement !== undefined ? { enforcement: nextEnforcement } : {}),
    ...(check !== undefined ? { check } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw new Error(
      'agile knowledge edit: nothing to change (give --text, --name, --kind, --scope, --path, --enforcement, --pattern, --question, --criteria-true/--criteria-false or --example)',
    );
  }
  const item = await callRpc<KnowledgeItem>(socketPath, 'knowledge.update', { id, ...patch });
  if (json) printJson(item);
  else console.log(`agile knowledge edit: ${item.id} updated (${Object.keys(patch).join(', ')})`);
  return 0;
}

async function decide(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
  method: 'knowledge.accept' | 'knowledge.retire',
): Promise<number> {
  const id = requirePositional(args, 0, 'knowledge-id');
  const by = optionalString(args.options, 'by');
  const item = await callRpc<KnowledgeItem>(socketPath, method, {
    id,
    ...(by !== undefined ? { by } : {}),
  });
  if (json) printJson(item);
  else
    console.log(
      `agile knowledge ${method === 'knowledge.accept' ? 'accept' : 'retire'}: ${item.id} is ${item.status}`,
    );
  return 0;
}

export async function runKnowledgeAccept(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  return decide(socketPath, args, json, 'knowledge.accept');
}

export async function runKnowledgeRetire(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  return decide(socketPath, args, json, 'knowledge.retire');
}

/** `id name tier status fired violated routed last_fired flag` — §5.7's columns. */
export const RULE_REPORT_HEADERS = [
  'id',
  'name',
  'tier',
  'status',
  'fired',
  'violated',
  'routed',
  'last_fired',
  'flag',
];

export function ruleReportRows(rows: readonly RuleReportRow[]): string[][] {
  return rows.map((row) => [
    row.id,
    row.name ?? '-',
    row.tier,
    row.status,
    String(row.fired),
    String(row.violated),
    String(row.routed),
    row.last_fired ?? '-',
    row.flag_detail,
  ]);
}

/**
 * `agile knowledge report [--days N]` — the pruning view of §5.7. The daemon
 * computes the flags (one implementation, shared with the UI of T163);
 * this prints them, flagged rules first.
 */
export async function runKnowledgeReport(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const days = optionalString(args.options, 'days');
  const report = await callRpc<RuleReport>(socketPath, 'knowledge.report', {
    ...(days !== undefined ? { days } : {}),
  });
  if (json) {
    printJson(report);
    return 0;
  }
  if (report.rows.length === 0) {
    console.log('knowledge: (none)');
    return 0;
  }
  printTable(RULE_REPORT_HEADERS, ruleReportRows(report.rows));
  const flagged = report.rows.filter((row) => row.flag !== '-').length;
  console.log('');
  console.log(
    `${report.rows.length} items · ${flagged} flagged for pruning (never-fired window ${report.days} days)`,
  );
  return 0;
}

/** `rule example expected probability band verdict` — §5.6's eval columns (D14: no confidence). */
export const RULE_TEST_HEADERS = ['rule', 'example', 'expected', 'probability', 'band', 'verdict'];

/** Slack over the classifier's own budget: the RPC round trip and the store. */
export const RULE_TEST_DEADLINE_SLACK_MS = 5_000;

/** T155: examples × the classifier timeout, plus slack — never under the default 5 s. */
export function ruleTestDeadlineMs(plan: RuleEvalPlan): number {
  return Math.max(5_000, plan.examples * plan.timeout_ms + RULE_TEST_DEADLINE_SLACK_MS);
}

/** Widest an example action gets in the plain table; `--json` has the whole thing. */
export const RULE_TEST_ACTION_MAX_CHARS = 60;

/**
 * T155: an example action can be a whole diff. The plain table is one row
 * per example, so its newlines collapse to spaces and it is cut to one
 * readable line; the `--json` report keeps the action verbatim.
 */
export function oneLine(text: string, max = RULE_TEST_ACTION_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Three decimals: a probability of 0.8 and one of 0.804 band differently. */
function num(value: number | undefined): string {
  return value === undefined ? '-' : value.toFixed(3);
}

export function ruleTestRows(report: RuleEvalReport): string[][] {
  const rows: string[][] = [];
  for (const rule of report.rules) {
    for (const example of rule.examples) {
      rows.push([
        rule.name ?? rule.id,
        oneLine(example.action),
        example.expected_band,
        num(example.probability),
        example.band ?? '-',
        example.error !== undefined
          ? `error: ${example.error}`
          : example.agree
            ? 'agree'
            : 'DISAGREE',
      ]);
    }
  }
  return rows;
}

/**
 * `agile knowledge test [id]` — §5.6's "examples as evals". Every accepted
 * classifier rule's examples go through the configured classifier and the
 * report says, per example, what came back and whether it matches the
 * example's own label.
 *
 * **Exit 1 on any disagreement or error**, so this is usable as a check:
 * an accepted classifier rule that no longer agrees with its own examples
 * is a gate that has started misfiring, and a silent zero would hide it.
 *
 * The raw Noul value is printed for every example, not only for
 * disagreements: it is the data `allow_below`/`deny_at` move on (D14).
 */
export async function runKnowledgeTest(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = args.positionals[0];
  const params = id !== undefined ? { id } : {};
  // T155: one classifier call per example, each allowed its own timeout —
  // the default 5 s RPC deadline gave up on a real suite while the daemon
  // kept going. Ask what the run costs first, and wait for all of it.
  const plan = await callRpc<RuleEvalPlan>(socketPath, 'knowledge.test', { ...params, plan: true });
  const report = await callRpc<RuleEvalReport>(socketPath, 'knowledge.test', params, {
    timeoutMs: ruleTestDeadlineMs(plan),
  });
  const failed = report.disagreed + report.errors;
  if (json) {
    printJson(report);
    return failed > 0 ? 1 : 0;
  }
  if (report.rules.length === 0) {
    console.log('agile knowledge test: no accepted classifier checks to evaluate');
    return 0;
  }
  printTable(RULE_TEST_HEADERS, ruleTestRows(report));
  console.log('');
  const rate =
    report.agreement_rate === undefined ? 'n/a' : `${(report.agreement_rate * 100).toFixed(1)}%`;
  console.log(
    `${report.rules.length} items · ${report.total} examples · ${report.agreed} agree · ${report.disagreed} disagree · ${report.errors} errors · agreement ${rate}`,
  );
  console.log(`bands: deny >= ${report.bands.deny_at} · allow < ${report.bands.allow_below}`);
  return failed > 0 ? 1 : 0;
}
