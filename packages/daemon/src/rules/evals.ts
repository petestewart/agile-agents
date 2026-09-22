/**
 * §5.6, examples as evals: `agile rules test [rule-id]` runs every accepted
 * classifier rule's `examples` through the configured classifier and reports
 * agreement.
 *
 * Why this exists at all: "two examples are mandatory for a classifier rule
 * … without them the rule cannot be evaluated, and an unevaluated
 * probabilistic gate is a rule that will start misfiring silently". The
 * store already refuses to accept such a rule (`assertRuleAcceptable`); this
 * is the other half — the examples that were mandated are actually run.
 *
 * **One classifier call per example.** §6.2's "one call per state, N
 * questions" batches *questions over one state*, and each example is a
 * different state — a different hypothetical action — so there is no batch
 * to make: two examples are two states, and the interface has no way to ask
 * about two states at once. (Where the batching does apply, the per-action
 * hook and the diff check, it is already used.) An eval run is a manual,
 * off-the-hot-path command, so N round trips is the right cost for an
 * answer per example.
 *
 * Nothing here writes. An eval is not a firing: `stats` counts what the
 * gates did to real actions (§5.7's pruning input), and seeding it with
 * self-tests would make the pruning report lie.
 */

import {
  type ClassifierBands,
  type Rule,
  RuleWriteError,
  classifierQuestion,
} from '@agile-agents/shared';
import { type Classifier, ClassifierUnavailableError, bandFor } from '../classifier';
import type { ClassifierBand } from '../classifier';

/** One example, asked and answered. */
export interface RuleEvalExample {
  action: string;
  /** The example's own label: `true` = this action violates the rule. */
  expected_violates: boolean;
  /** The band the label asks for — `deny` for a violation, `allow` for a clean action. */
  expected_band: Exclude<ClassifierBand, 'route'>;
  /** Absent when the call failed. */
  probability?: number;
  confidence?: number;
  /** `bandFor(answer, bands)`; absent when the call failed. */
  band?: ClassifierBand;
  /** True when `band === expected_band`. A `route` is a disagreement: the example has a verdict. */
  agree: boolean;
  /** Why no answer: the classifier was unavailable, or answered nothing for this rule. */
  error?: string;
}

/** One rule's evals. */
export interface RuleEvalRule {
  id: string;
  name?: string;
  /** What was actually asked — `rule.question`, or §5.1's default. */
  question: string;
  critical: boolean;
  examples: RuleEvalExample[];
  agreed: number;
  disagreed: number;
  errors: number;
}

export interface RuleEvalReport {
  /** The thresholds the bands were read with, so a report says what 0.8 meant when it ran. */
  bands: ClassifierBands;
  generated_at: string;
  rules: RuleEvalRule[];
  /** Totals over every example in every rule tested. */
  total: number;
  agreed: number;
  disagreed: number;
  errors: number;
  /** The agreement rate over the examples that got an answer; `undefined` when none did. */
  agreement_rate?: number;
}

/** The slice of `RulesService` an eval run reads. Read-only by construction. */
export interface RuleEvalRules {
  get(id: string): Rule;
  list(): Rule[];
}

export interface RunRuleEvalsOptions {
  rules: RuleEvalRules;
  classifier: Classifier;
  bands: ClassifierBands;
  /** One rule instead of every accepted classifier rule. */
  ruleId?: string;
  /** Test seam; real usage runs on the system clock. */
  clock?: () => Date;
}

/**
 * A named rule that cannot be evaluated — not a classifier rule, or not
 * accepted. Typed so the RPC edge reports it as `invalid params` (-32602):
 * it is the caller naming the wrong rule, not a daemon fault. Reuses
 * `RuleWriteError`'s role for the same reason the accept path does.
 */
export class RuleNotEvaluableError extends RuleWriteError {
  constructor(message: string) {
    super(message);
    this.name = 'RuleNotEvaluableError';
  }
}

/** Every accepted `classifier` rule, or the one named (which must be one). */
export function evaluableRules(rules: RuleEvalRules, ruleId?: string): Rule[] {
  if (ruleId === undefined) {
    return rules
      .list()
      .filter((rule) => rule.status === 'accepted' && rule.enforcement === 'classifier');
  }
  const rule = rules.get(ruleId);
  if (rule.enforcement !== 'classifier') {
    throw new RuleNotEvaluableError(
      `rule ${rule.id} is a ${rule.enforcement} rule: only classifier rules have examples to evaluate (§5.6)`,
    );
  }
  if (rule.status !== 'accepted') {
    throw new RuleNotEvaluableError(
      `rule ${rule.id} is ${rule.status}: only accepted rules are evaluated (a proposal is not a gate)`,
    );
  }
  return [rule];
}

export async function runRuleEvals(options: RunRuleEvalsOptions): Promise<RuleEvalReport> {
  const clock = options.clock ?? (() => new Date());
  const selected = evaluableRules(options.rules, options.ruleId);
  const rules: RuleEvalRule[] = [];
  for (const rule of selected) {
    rules.push(await evalRule(rule, options));
  }
  const total = rules.reduce((n, r) => n + r.examples.length, 0);
  const agreed = rules.reduce((n, r) => n + r.agreed, 0);
  const disagreed = rules.reduce((n, r) => n + r.disagreed, 0);
  const errors = rules.reduce((n, r) => n + r.errors, 0);
  const answered = agreed + disagreed;
  return {
    bands: options.bands,
    generated_at: clock().toISOString(),
    rules,
    total,
    agreed,
    disagreed,
    errors,
    ...(answered > 0 ? { agreement_rate: agreed / answered } : {}),
  };
}

async function evalRule(rule: Rule, options: RunRuleEvalsOptions): Promise<RuleEvalRule> {
  const question = classifierQuestion(rule);
  const examples: RuleEvalExample[] = [];
  for (const example of rule.examples) {
    examples.push(await evalExample(rule, question, example.action, example.violates, options));
  }
  return {
    id: rule.id,
    ...(rule.name !== undefined ? { name: rule.name } : {}),
    question,
    critical: rule.critical,
    examples,
    agreed: examples.filter((e) => e.agree).length,
    disagreed: examples.filter((e) => !e.agree && e.error === undefined).length,
    errors: examples.filter((e) => e.error !== undefined).length,
  };
}

async function evalExample(
  rule: Rule,
  question: string,
  action: string,
  violates: boolean,
  options: RunRuleEvalsOptions,
): Promise<RuleEvalExample> {
  const expected_band: Exclude<ClassifierBand, 'route'> = violates ? 'deny' : 'allow';
  const base = { action, expected_violates: violates, expected_band };
  let answers: Awaited<ReturnType<Classifier['ask']>>;
  try {
    answers = await options.classifier.ask(action, [{ id: rule.id, question }]);
  } catch (error) {
    // §6.4's fail policy is about *gating an action*; an eval has no action
    // to gate, so an unavailable classifier is simply an example with no
    // answer — reported, counted as an error, and never silently agreed.
    return {
      ...base,
      agree: false,
      error:
        error instanceof ClassifierUnavailableError
          ? `classifier unavailable (${error.reason}): ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
  const answer = answers.find((a) => a.id === rule.id);
  if (answer === undefined) {
    return { ...base, agree: false, error: 'the classifier returned no answer for this rule' };
  }
  const band = bandFor(answer, options.bands);
  return {
    ...base,
    probability: answer.probability,
    confidence: answer.confidence,
    band,
    agree: band === expected_band,
  };
}
