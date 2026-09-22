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

import { readPlanV1Decisions, seedProposal } from '@agile-agents/daemon';
import {
  RULE_ENFORCEMENTS,
  RULE_STATUSES,
  type Rule,
  type RuleEnforcement,
  type RuleExample,
  type RuleStage,
  type RuleStatus,
  classifierQuestion,
  formatRuleScope,
  parseRuleScope,
} from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { hasFlag, optionalString, requireOption, requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson, printTable } from '../format';

/** `id status tier scope text` — the table shape of `agile rules list`. */
export const RULE_HEADERS = ['id', 'status', 'tier', 'scope', 'text'];

/**
 * The `tier` cell is the enforcement tier (§5.2), with `!` marking a
 * critical rule — the one property that changes what a denial costs.
 */
export function ruleRows(rules: readonly Rule[]): string[][] {
  return rules.map((rule) => [
    rule.id,
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
    ['status', rule.status],
    ['text', rule.text],
    ['scope', formatRuleScope(rule.scope)],
    ['enforcement', rule.enforcement],
    ['stage', rule.stage],
    ['critical', String(rule.critical)],
  ];
  if (rule.enforcement === 'classifier') fields.push(['question', classifierQuestion(rule)]);
  if (rule.pattern !== undefined) {
    fields.push(['pattern', `${rule.pattern.kind} ${JSON.stringify(rule.pattern.args)}`]);
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
  const examples = parseExamples(argv);
  const rule = await callRpc<Rule>(socketPath, 'rule.create', {
    text,
    ...(scopeText !== undefined ? { scope: parseRuleScope(scopeText) } : {}),
    ...(enforcement !== undefined ? { enforcement } : {}),
    ...(stage !== undefined ? { stage } : {}),
    ...(question !== undefined ? { question } : {}),
    ...(examples.length > 0 ? { examples } : {}),
    ...(hasFlag(args.options, 'critical') ? { critical: true } : {}),
  });
  if (json) printJson(rule);
  else console.log(`agile rules add: ${rule.id} proposed (${formatRuleScope(rule.scope)})`);
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
