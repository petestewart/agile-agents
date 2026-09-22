/**
 * §5.7's pruning report — one row per rule, with the three pruning signals
 * the design names: never fired, fired-often-never-violated, routed often.
 *
 * The counts are read from `rule.stats` **as stored**. They are written by
 * the hook path (§8.1, T151) and the diff check (§8.2, T152) as those rules
 * fire; there is no accounting pass here and no second source of truth. A
 * rule written before those counters existed simply reads as zero
 * (`RuleStatsSchema` defaults every counter), so the report never has to
 * guess whether a zero means "never fired" or "never counted".
 *
 * The flags are mechanical, like §5.3's scope filter: the report states
 * which signal a rule trips, and the human decides whether to retire it.
 * Nothing here writes, and nothing here retires a rule automatically — a
 * rule is a decision, and un-deciding one is the human's act (§5.1/D4).
 */

import type { Rule, RuleStatus } from '@agile-agents/shared';
import type { RulesService } from './service';

/** Default `--days` for the "never fired" window (§5.7). */
export const RULE_REPORT_DEFAULT_DAYS = 14;

/** `never violated` needs enough firings for the silence to mean something. */
export const RULE_REPORT_NEVER_VIOLATED_MIN_FIRED = 10;

/** `routes often`: at least this share of firings ended in the human inbox. */
export const RULE_REPORT_ROUTE_RATIO = 0.3;

/** …over at least this many firings, so one route out of two is not a signal. */
export const RULE_REPORT_ROUTE_MIN_FIRED = 5;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `-` is "no signal", not "healthy": a proposed rule cannot have fired yet. */
export type RuleReportFlag = 'never fired' | 'never violated' | 'routes often' | '-';

export interface RuleReportRow {
  id: string;
  /** The built-in's §5.4 name, absent for every rule a human or agent wrote (T145). */
  name?: string;
  /** The enforcement tier, `!`-marked when critical — as `agile rules list` prints it. */
  tier: string;
  status: RuleStatus;
  fired: number;
  violated: number;
  routed: number;
  /** ISO timestamp of the last firing, absent when the rule never fired. */
  last_fired?: string;
  flag: RuleReportFlag;
  /** The flag as a printed cell: `never fired (14 days)` carries the window. */
  flag_detail: string;
}

export interface RuleReport {
  /** The "never fired in N days" window this report was computed with. */
  days: number;
  generated_at: string;
  rows: RuleReportRow[];
}

export interface RuleReportOptions {
  days?: number;
  /** Test seam; real usage runs on the system clock. */
  now?: Date;
}

function tierOf(rule: Rule): string {
  return `${rule.enforcement}${rule.critical ? '!' : ''}`;
}

function ageInDays(rule: Rule, now: Date): number {
  const created = Date.parse(rule.created_at);
  if (Number.isNaN(created)) return 0;
  return (now.getTime() - created) / MS_PER_DAY;
}

/**
 * The first signal a rule trips, most actionable first. The three are very
 * nearly exclusive anyway — "never fired" means `fired === 0`, and both of
 * the others need firings — so the order only settles the impossible case.
 */
function flagOf(rule: Rule, days: number, now: Date): RuleReportFlag {
  const { fired, violated, routed } = rule.stats;
  // Only an *accepted* rule can fire, so silence from a proposed or retired
  // rule says nothing about whether the situation arises here.
  if (rule.status === 'accepted' && fired === 0 && ageInDays(rule, now) >= days) {
    return 'never fired';
  }
  // T145: `never violated` is a prune signal only where a violation is a
  // thing that can be *recorded without being stopped* — a classifier (or a
  // guidance) rule the model judges each call against. A pattern rule that
  // fires is doing its job: the pattern matched and the call was denied, so
  // `violated: 0` over a thousand firings means the rule works, not that it
  // is dead weight. Flagging those was telling the operator to retire
  // `no_push_protected` for being effective.
  if (
    rule.enforcement !== 'pattern' &&
    fired >= RULE_REPORT_NEVER_VIOLATED_MIN_FIRED &&
    violated === 0
  ) {
    return 'never violated';
  }
  if (fired >= RULE_REPORT_ROUTE_MIN_FIRED && routed / fired >= RULE_REPORT_ROUTE_RATIO) {
    return 'routes often';
  }
  return '-';
}

/**
 * One row per rule, flagged rows first (they are the point of the view),
 * then by `fired` descending, then by id so the order is total and a
 * snapshot test does not depend on the store's read order.
 */
export function ruleReportRows(
  rules: readonly Rule[],
  options: RuleReportOptions = {},
): RuleReportRow[] {
  const days = options.days ?? RULE_REPORT_DEFAULT_DAYS;
  const now = options.now ?? new Date();
  const rows = rules.map((rule): RuleReportRow => {
    const flag = flagOf(rule, days, now);
    return {
      id: rule.id,
      ...(rule.name !== undefined ? { name: rule.name } : {}),
      tier: tierOf(rule),
      status: rule.status,
      fired: rule.stats.fired,
      violated: rule.stats.violated,
      routed: rule.stats.routed,
      ...(rule.stats.last_fired_at !== undefined ? { last_fired: rule.stats.last_fired_at } : {}),
      flag,
      flag_detail: flag === 'never fired' ? `never fired (${days} days)` : flag,
    };
  });
  return rows.sort((a, b) => {
    const flagged = Number(b.flag !== '-') - Number(a.flag !== '-');
    if (flagged !== 0) return flagged;
    if (b.fired !== a.fired) return b.fired - a.fired;
    return a.id.localeCompare(b.id);
  });
}

/** `rule.report`'s payload: every rule in this home, flagged (§5.7). */
export function buildRuleReport(
  service: RulesService,
  options: RuleReportOptions = {},
): RuleReport {
  const now = options.now ?? new Date();
  return {
    days: options.days ?? RULE_REPORT_DEFAULT_DAYS,
    generated_at: now.toISOString(),
    rows: ruleReportRows(service.list(), { ...options, now }),
  };
}
