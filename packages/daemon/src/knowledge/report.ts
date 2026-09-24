/**
 * §5.7's pruning report: one row per rule with its signal (never fired,
 * fired often but never violated, routed often), read from `rule.stats`
 * as stored (unset counters default to zero). Mechanical and read-only:
 * the human decides whether to retire (§5.1, D4).
 */

import { type KnowledgeItem, type KnowledgeStatus, formatEnforcement } from '@agile-agents/shared';
import type { KnowledgeService } from './service';

/** Default `--days` for the "never fired" window (§5.7). */
export const RULE_REPORT_DEFAULT_DAYS = 14;

/** `never violated` needs enough firings for the silence to mean something. */
export const RULE_REPORT_NEVER_VIOLATED_MIN_FIRED = 10;

/** `routes often`: at least this share of firings ended in the human inbox. */
export const RULE_REPORT_ROUTE_RATIO = 0.3;

/** …over at least this many firings. */
export const RULE_REPORT_ROUTE_MIN_FIRED = 5;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `-` is "no signal", not "healthy": a proposed rule cannot have fired yet. */
export type RuleReportFlag = 'never fired' | 'never violated' | 'routes often' | '-';

export interface RuleReportRow {
  id: string;
  /** The built-in's §5.4 name; absent for rules a human or agent wrote. */
  name?: string;
  /** The tier, `!`-marked when critical (as `agile rules list` prints it). */
  tier: string;
  status: KnowledgeStatus;
  fired: number;
  violated: number;
  routed: number;
  /** Last firing; absent when the rule never fired. */
  last_fired?: string;
  flag: RuleReportFlag;
  /** The printed cell: `never fired (14 days)` carries the window. */
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
  /** Test seam. */
  now?: Date;
}

function tierOf(rule: KnowledgeItem): string {
  return formatEnforcement(rule);
}

function ageInDays(rule: KnowledgeItem, now: Date): number {
  const created = Date.parse(rule.created_at);
  if (Number.isNaN(created)) return 0;
  return (now.getTime() - created) / MS_PER_DAY;
}

/** The first signal a rule trips (they are nearly exclusive anyway). */
function flagOf(rule: KnowledgeItem, days: number, now: Date): RuleReportFlag {
  const { fired, violated, routed } = rule.stats;
  // Only an accepted rule can fire; a proposal's silence says nothing.
  if (rule.status === 'accepted' && fired === 0 && ageInDays(rule, now) >= days) {
    return 'never fired';
  }
  // `never violated` is a prune signal only where a violation can be
  // recorded without being stopped (a classifier check, a tell item). A
  // pattern check that fires denies the call, so `violated: 0` means it works.
  if (
    rule.check?.by !== 'pattern' &&
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

/** One row per rule: flagged first, then by `fired` descending, then by id (a total order). */
export function ruleReportRows(
  rules: readonly KnowledgeItem[],
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
  service: KnowledgeService,
  options: RuleReportOptions = {},
): RuleReport {
  const now = options.now ?? new Date();
  return {
    days: options.days ?? RULE_REPORT_DEFAULT_DAYS,
    generated_at: now.toISOString(),
    rows: ruleReportRows(service.list(), { ...options, now }),
  };
}
