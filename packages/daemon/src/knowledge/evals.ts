/**
 * §5.6, examples as evals: `agile rules test [rule-id]` runs each accepted
 * classifier rule's `examples` through the configured classifier and
 * reports agreement, so the mandated examples are actually run (an
 * unevaluated probabilistic gate misfires silently).
 *
 * One call per example: §6.2 batches questions over one state, and each
 * example is a different state. An eval is manual and off the hot path.
 * Nothing here writes `stats`: an eval is not a firing, and counting
 * self-tests would make the pruning report lie.
 */

import {
  type ClassifierBands,
  type KnowledgeItem,
  KnowledgeWriteError,
  classifierCheckOf,
  classifierQuestion,
  examplesOf,
} from '@agile-agents/shared';
import { type Classifier, ClassifierUnavailableError, bandFor, noulFor } from '../classifier';
import type { ClassifierBand } from '../classifier';

/** One example, asked and answered. */
export interface RuleEvalExample {
  action: string;
  /** The example's own label: `true` = this action violates the rule. */
  expected_violates: boolean;
  /** `deny` for a violation, `allow` for a clean action. */
  expected_band: Exclude<ClassifierBand, 'route'>;
  /** The raw Noul value (D14); absent when the call failed. */
  probability?: number;
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
  /** What was asked: `rule.question`, or §5.1's default. */
  question: string;
  critical: boolean;
  examples: RuleEvalExample[];
  agreed: number;
  disagreed: number;
  errors: number;
}

export interface RuleEvalReport {
  /** The thresholds the bands were read with. */
  bands: ClassifierBands;
  generated_at: string;
  rules: RuleEvalRule[];
  /** Totals over every example in every rule tested. */
  total: number;
  agreed: number;
  disagreed: number;
  errors: number;
  /** Agreement over the examples that got an answer; `undefined` when none did. */
  agreement_rate?: number;
}

/** The slice of `KnowledgeService` an eval run reads. */
export interface RuleEvalRules {
  get(id: string): KnowledgeItem;
  list(): KnowledgeItem[];
}

export interface RunRuleEvalsOptions {
  rules: RuleEvalRules;
  classifier: Classifier;
  bands: ClassifierBands;
  /** One rule instead of every accepted classifier rule. */
  ruleId?: string;
  /** Test seam. */
  clock?: () => Date;
  /** Called once per classifier call, so evals leave the same `classifier_call` trail (§6.2). Failures are swallowed. */
  onCall?: (call: RuleEvalCall) => Promise<unknown> | unknown;
}

/** One eval call, as `onCall` sees it. */
export interface RuleEvalCall {
  rule: string;
  latency_ms: number;
  /** Absent when the call failed or returned nothing for the rule. */
  band?: ClassifierBand;
  error?: string;
}

/** A named rule that can't be evaluated (not classifier, or not accepted): caller input, -32602. */
export class RuleNotEvaluableError extends KnowledgeWriteError {
  constructor(message: string) {
    super(message);
    this.name = 'RuleNotEvaluableError';
  }
}

/** Every accepted `classifier` rule, or the one named (which must be one). */
export function evaluableRules(rules: RuleEvalRules, ruleId?: string): KnowledgeItem[] {
  if (ruleId === undefined) {
    return rules
      .list()
      .filter((rule) => rule.status === 'accepted' && classifierCheckOf(rule) !== undefined);
  }
  const rule = rules.get(ruleId);
  if (classifierCheckOf(rule) === undefined) {
    throw new RuleNotEvaluableError(
      `knowledge item ${rule.id} has no classifier check (${rule.check?.by ?? rule.enforcement}): only classifier checks have examples to evaluate (§5.6)`,
    );
  }
  if (rule.status !== 'accepted') {
    throw new RuleNotEvaluableError(
      `knowledge item ${rule.id} is ${rule.status}: only accepted items are evaluated (a proposal is not a gate)`,
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

async function evalRule(rule: KnowledgeItem, options: RunRuleEvalsOptions): Promise<RuleEvalRule> {
  const question = classifierQuestion(rule);
  const examples: RuleEvalExample[] = [];
  for (const example of examplesOf(rule)) {
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
  rule: KnowledgeItem,
  question: string,
  action: string,
  violates: boolean,
  options: RunRuleEvalsOptions,
): Promise<RuleEvalExample> {
  const expected_band: Exclude<ClassifierBand, 'route'> = violates ? 'deny' : 'allow';
  const base = { action, expected_violates: violates, expected_band };
  const started = Date.now();
  const record = async (band?: ClassifierBand, error?: string): Promise<void> => {
    if (options.onCall === undefined) return;
    try {
      await options.onCall({
        rule: rule.id,
        latency_ms: Date.now() - started,
        ...(band !== undefined ? { band } : {}),
        ...(error !== undefined ? { error } : {}),
      });
    } catch {
      // Telemetry: losing one event must not fail the eval.
    }
  };
  let answers: Awaited<ReturnType<Classifier['ask']>>;
  try {
    answers = await options.classifier.ask(action, [noulFor(rule)]);
  } catch (error) {
    // §6.4 is about gating an action; here an unavailable classifier is an
    // example with no answer, counted as an error, never silently agreed.
    const message =
      error instanceof ClassifierUnavailableError
        ? `classifier unavailable (${error.reason}): ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    await record(undefined, message);
    return { ...base, agree: false, error: message };
  }
  const answer = answers.find((a) => a.id === rule.id);
  if (answer === undefined) {
    const message = 'the classifier returned no answer for this rule';
    await record(undefined, message);
    return { ...base, agree: false, error: message };
  }
  const band = bandFor(answer, options.bands);
  await record(band);
  return {
    ...base,
    probability: answer.probability,
    band,
    agree: band === expected_band,
  };
}
