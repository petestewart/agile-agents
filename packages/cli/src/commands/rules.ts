/**
 * `agile rules list|show|add|accept|retire|seed` (T140) — the CLI over the
 * daemon's `rule.*` RPC (cockpit design §5). Thin, like `stream.ts`: parse
 * argv, call one method, print human or `--json`.
 *
 * Every write here is the human's: the daemon stamps the `human` principal
 * at the RPC edge and never accepts one from params (§2.2), so there is no
 * `--as` flag and never will be one on this path. An agent proposes
 * through its `propose_rule` verb.
 */

import {
  type RuleEvalPlan,
  type RuleEvalReport,
  type RuleReport,
  type RuleReportRow,
  readPlanV1Decisions,
  seedProposal,
} from '@agile-agents/daemon';
import {
  PATTERN_RULE_NEEDS_PATTERN,
  RULE_ENFORCEMENTS,
  RULE_STATUSES,
  type Rule,
  type RuleCriteria,
  type RuleEnforcement,
  type RuleExample,
  type RulePattern,
  type RuleStage,
  type RuleStatus,
  classifierQuestion,
  formatRulePattern,
  formatRuleScope,
  parseRuleScope,
  rulePatternFromArgs,
} from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { hasFlag, optionalString, requireOption, requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson, printTable } from '../format';

/**
 * `id name status tier scope text` — the table shape of `agile rules list`.
 * T145: `name` is the built-in's §5.4 name (`no_push_protected`, …) and `-`
 * for every rule a human or an agent wrote, which have no name but their id.
 */
export const RULE_HEADERS = ['id', 'name', 'status', 'tier', 'scope', 'text'];

/**
 * The `tier` cell is the enforcement tier (§5.2), with `!` marking a
 * critical rule — the one property that changes what a denial costs.
 */
export function ruleRows(rules: readonly Rule[]): string[][] {
  return rules.map((rule) => [
    rule.id,
    rule.name ?? '-',
    rule.status,
    `${rule.enforcement}${rule.critical ? '!' : ''}`,
    formatRuleScope(rule.scope),
    rule.text,
  ]);
}

/** The `agile rules show` field block. */
export function showFields(rule: Rule): Array<[string, string]> {
  const fields: Array<[string, string]> = [
    ['id', rule.id],
    ['name', rule.name ?? '-'],
    ['status', rule.status],
    ['text', rule.text],
    ['scope', formatRuleScope(rule.scope)],
    ['enforcement', rule.enforcement],
    ['stage', rule.stage],
    ['critical', String(rule.critical)],
  ];
  if (rule.enforcement === 'classifier') fields.push(['question', classifierQuestion(rule)]);
  if (rule.criteria !== undefined) {
    fields.push(['criteria true', rule.criteria.true], ['criteria false', rule.criteria.false]);
  }
  if (rule.pattern !== undefined) {
    fields.push(['pattern', formatRulePattern(rule.pattern)]);
  }
  fields.push(
    ['provenance', formatProvenance(rule)],
    [
      'stats',
      `fired ${rule.stats.fired} · violated ${rule.stats.violated} · routed ${rule.stats.routed}${rule.stats.last_fired_at ? ` · last ${rule.stats.last_fired_at}` : ''}`,
    ],
    ['created_at', rule.created_at],
    [
      'decided',
      rule.decided_at === undefined ? '-' : `${rule.decided_at} by ${rule.decided_by ?? '-'}`,
    ],
  );
  return fields;
}

function formatProvenance(rule: Rule): string {
  const { by, stream, session, finding } = rule.provenance;
  const parts = [by];
  if (stream !== undefined) parts.push(`stream ${stream}`);
  if (session !== undefined) parts.push(`session ${session}`);
  if (finding !== undefined) parts.push(`finding ${finding}`);
  return parts.join(' · ');
}

function optionalStatusOption(args: ParsedArgs): RuleStatus | undefined {
  const value = optionalString(args.options, 'status');
  if (value === undefined) return undefined;
  if (!(RULE_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`--status must be one of ${RULE_STATUSES.join(', ')}`);
  }
  return value as RuleStatus;
}

function optionalEnforcement(args: ParsedArgs): RuleEnforcement | undefined {
  const value = optionalString(args.options, 'enforcement');
  if (value === undefined) return undefined;
  if (!(RULE_ENFORCEMENTS as readonly string[]).includes(value)) {
    throw new Error(`--enforcement must be one of ${RULE_ENFORCEMENTS.join(', ')}`);
  }
  return value as RuleEnforcement;
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

/** Every `--example` on the command line, in order (`parseArgs` keeps the last of a repeated flag). */
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

export async function runRulesList(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const status = optionalStatusOption(args);
  const scope = optionalString(args.options, 'scope');
  const result = await callRpc<{ rules: Rule[] }>(socketPath, 'rule.list', {
    ...(status !== undefined ? { status } : {}),
    ...(scope !== undefined ? { scope } : {}),
  });
  if (json) {
    printJson(result);
    return 0;
  }
  if (result.rules.length === 0) {
    console.log('rules: (none)');
    return 0;
  }
  printTable(RULE_HEADERS, ruleRows(result.rules));
  return 0;
}

export async function runRulesShow(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = requirePositional(args, 0, 'rule-id');
  const rule = await callRpc<Rule>(socketPath, 'rule.get', { id });
  if (json) printJson(rule);
  else {
    printFields(showFields(rule));
    if (rule.examples.length > 0) {
      console.log('');
      console.log(`examples (${rule.examples.length}):`);
      for (const example of rule.examples) {
        console.log(`  ${example.violates ? 'violates' : 'allowed '}  ${example.action}`);
      }
    }
  }
  return 0;
}

/**
 * T167: `--pattern <kind> [--pattern-arg <value>]…` — a pattern-tier rule's
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
 * T156: `--criteria-true "…" --criteria-false "…"` — the rule's criteria
 * (D14), both or neither: a Noul criteria pair describes both answers.
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

/**
 * `agile rules add` writes a **proposal**, like every other create (§5.1):
 * the human's authority lives in `agile rules accept`, which is a second,
 * explicit act. `--stage` mirrors §5.1's `stage` default of `action`.
 */
export async function runRulesAdd(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
  argv: readonly string[] = [],
): Promise<number> {
  const text = requireOption(args.options, 'text');
  const scopeText = optionalString(args.options, 'scope');
  const enforcement = optionalEnforcement(args);
  const stage = optionalString(args.options, 'stage') as RuleStage | undefined;
  const question = optionalString(args.options, 'question');
  const criteria = parseCriteria(args);
  const examples = parseExamples(argv);
  const pattern = parsePattern(args, argv);
  if (enforcement === 'pattern' && pattern === undefined) {
    throw new Error(`agile rules add: ${PATTERN_RULE_NEEDS_PATTERN}`);
  }
  const rule = await callRpc<Rule>(socketPath, 'rule.create', {
    text,
    ...(scopeText !== undefined ? { scope: parseRuleScope(scopeText) } : {}),
    ...(enforcement !== undefined ? { enforcement } : {}),
    ...(stage !== undefined ? { stage } : {}),
    ...(question !== undefined ? { question } : {}),
    ...(criteria !== undefined ? { criteria } : {}),
    ...(examples.length > 0 ? { examples } : {}),
    ...(pattern !== undefined ? { pattern } : {}),
    ...(hasFlag(args.options, 'critical') ? { critical: true } : {}),
  });
  if (json) printJson(rule);
  else console.log(`agile rules add: ${rule.id} proposed (${formatRuleScope(rule.scope)})`);
  return 0;
}

/**
 * `agile rules edit <id> [--text …] [--question …] [--criteria-true …
 * --criteria-false …] [--enforcement …] [--stage …] [--example "action::bool" …]` — §3.1's edit-then-accept over
 * `rule.update` (T155). Only the flags given are sent; `--example`
 * replaces the whole example list, as `rule.update` does.
 */
export async function runRulesEdit(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
  argv: readonly string[] = [],
): Promise<number> {
  const id = requirePositional(args, 0, 'rule-id');
  const text = optionalString(args.options, 'text');
  const question = optionalString(args.options, 'question');
  const criteria = parseCriteria(args);
  const enforcement = optionalEnforcement(args);
  const stage = optionalString(args.options, 'stage') as RuleStage | undefined;
  const examples = parseExamples(argv);
  const pattern = parsePattern(args, argv);
  const patch = {
    ...(text !== undefined ? { text } : {}),
    ...(question !== undefined ? { question } : {}),
    ...(criteria !== undefined ? { criteria } : {}),
    ...(enforcement !== undefined ? { enforcement } : {}),
    ...(stage !== undefined ? { stage } : {}),
    ...(examples.length > 0 ? { examples } : {}),
    ...(pattern !== undefined ? { pattern } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw new Error(
      'agile rules edit: nothing to change (give --text, --question, --criteria-true/--criteria-false, --enforcement, --stage, --pattern or --example)',
    );
  }
  const rule = await callRpc<Rule>(socketPath, 'rule.update', { id, ...patch });
  if (json) printJson(rule);
  else console.log(`agile rules edit: ${rule.id} updated (${Object.keys(patch).join(', ')})`);
  return 0;
}

async function decide(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
  method: 'rule.accept' | 'rule.retire',
): Promise<number> {
  const id = requirePositional(args, 0, 'rule-id');
  const by = optionalString(args.options, 'by');
  const rule = await callRpc<Rule>(socketPath, method, {
    id,
    ...(by !== undefined ? { by } : {}),
  });
  if (json) printJson(rule);
  else
    console.log(
      `agile rules ${method === 'rule.accept' ? 'accept' : 'retire'}: ${rule.id} is ${rule.status}`,
    );
  return 0;
}

export async function runRulesAccept(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  return decide(socketPath, args, json, 'rule.accept');
}

export async function runRulesRetire(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  return decide(socketPath, args, json, 'rule.retire');
}

/**
 * `agile rules seed --from PLAN-v1.md` (T140 Notes): imports the decisions
 * the project already made as `proposed` global `guidance` rules, so the
 * first accept pass is over real material. Idempotent: a decision whose
 * text is already a rule is skipped, so a second run creates nothing.
 *
 * The parse lives in the daemon package beside `RulesService`
 * (`rules/seed-plan-v1.ts`); the creates go over the ordinary
 * `rule.create` edge, so the seed has no privileges the operator does not
 * and the daemon never reads a path a request named.
 */
export async function runRulesSeed(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const from = optionalString(args.options, 'from') ?? args.positionals[0];
  if (from === undefined) throw new Error('agile rules seed: --from <path> is required');
  const decisions = readPlanV1Decisions(from);
  const existing = new Set(
    (await callRpc<{ rules: Rule[] }>(socketPath, 'rule.list', {})).rules.map((rule) => rule.text),
  );
  const created: string[] = [];
  const skipped: string[] = [];
  for (const text of decisions) {
    if (existing.has(text)) {
      skipped.push(text);
      continue;
    }
    const rule = await callRpc<Rule>(socketPath, 'rule.create', seedProposal(text));
    existing.add(text);
    created.push(rule.id);
  }
  if (json) printJson({ from, found: decisions.length, created, skipped: skipped.length });
  else {
    console.log(
      `agile rules seed: ${created.length} proposed from ${from} (${decisions.length} decisions found, ${skipped.length} already present)`,
    );
    console.log('review them with `agile rules list --status proposed`');
  }
  return 0;
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
 * `agile rules report [--days N]` — the pruning view of §5.7. The daemon
 * computes the flags (one implementation, shared with the UI of T163);
 * this prints them, flagged rules first.
 */
export async function runRulesReport(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const days = optionalString(args.options, 'days');
  const report = await callRpc<RuleReport>(socketPath, 'rule.report', {
    ...(days !== undefined ? { days } : {}),
  });
  if (json) {
    printJson(report);
    return 0;
  }
  if (report.rows.length === 0) {
    console.log('rules: (none)');
    return 0;
  }
  printTable(RULE_REPORT_HEADERS, ruleReportRows(report.rows));
  const flagged = report.rows.filter((row) => row.flag !== '-').length;
  console.log('');
  console.log(
    `${report.rows.length} rules · ${flagged} flagged for pruning (never-fired window ${report.days} days)`,
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
 * `agile rules test [rule-id]` — §5.6's "examples as evals". Every accepted
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
export async function runRulesTest(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const id = args.positionals[0];
  const params = id !== undefined ? { id } : {};
  // T155: one classifier call per example, each allowed its own timeout —
  // the default 5 s RPC deadline gave up on a real suite while the daemon
  // kept going. Ask what the run costs first, and wait for all of it.
  const plan = await callRpc<RuleEvalPlan>(socketPath, 'rule.test', { ...params, plan: true });
  const report = await callRpc<RuleEvalReport>(socketPath, 'rule.test', params, {
    timeoutMs: ruleTestDeadlineMs(plan),
  });
  const failed = report.disagreed + report.errors;
  if (json) {
    printJson(report);
    return failed > 0 ? 1 : 0;
  }
  if (report.rules.length === 0) {
    console.log('agile rules test: no accepted classifier rules to evaluate');
    return 0;
  }
  printTable(RULE_TEST_HEADERS, ruleTestRows(report));
  console.log('');
  const rate =
    report.agreement_rate === undefined ? 'n/a' : `${(report.agreement_rate * 100).toFixed(1)}%`;
  console.log(
    `${report.rules.length} rules · ${report.total} examples · ${report.agreed} agree · ${report.disagreed} disagree · ${report.errors} errors · agreement ${rate}`,
  );
  console.log(`bands: deny >= ${report.bands.deny_at} · allow < ${report.bands.allow_below}`);
  return failed > 0 ? 1 : 0;
}
