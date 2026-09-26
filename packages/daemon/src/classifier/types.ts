/**
 * The classifier tier's interface (§6.2): `ask(state, questions: Noul[]):
 * Promise<Answer[]>`. Per D14 an `Answer` carries only the Noul value (a
 * Noul has no separate confidence) and a `Noul` may carry `criteria`.
 * Plain types, not shared schemas: nothing here is persisted state.
 */

import {
  type KnowledgeItem,
  type RuleCriteria,
  classifierCheckOf,
  classifierQuestion,
} from '@agile-agents/shared';

/** One yes/no question about the state. `id` is the rule's id in practice. */
export interface Noul {
  id: string;
  question: string;
  /** What "yes" (the rule is broken) and "no" look like, when the line is subtle. */
  criteria?: RuleCriteria;
}

/** The Noul for one rule: its classifier question plus its criteria, if any. */
export function noulFor(
  rule: Pick<KnowledgeItem, 'id' | 'text' | 'check'> & Partial<Pick<KnowledgeItem, 'enforcement'>>,
): Noul {
  const criteria = classifierCheckOf(rule)?.criteria;
  return {
    id: rule.id,
    question: classifierQuestion(rule),
    ...(criteria !== undefined ? { criteria } : {}),
  };
}

/** One answer by question `id`; `probability` is the raw Noul value (D14). */
export interface Answer {
  id: string;
  probability: number;
}

/** What `onCall` gets after every attempt (§6.2). */
export interface ClassifierCallInfo {
  /** From entering `ask` to resolving or failing. */
  latency_ms: number;
  /** Questions carried by the one call. */
  questions: number;
  ok: boolean;
  /** The failure, when `ok` is false. */
  error?: string;
}

/**
 * §6.2: one call per state, N questions, one `Answer` per `Noul` in order.
 * Throws `ClassifierUnavailableError` when it can't ask at all; the caller
 * applies §6.4's fail policy.
 */
export interface Classifier {
  ask(state: string, questions: Noul[]): Promise<Answer[]>;
}

/**
 * The classifier couldn't answer. One type for every reason, since §6.4
 * treats them alike; `reason` is the machine-readable discriminator.
 */
export type ClassifierUnavailableReason =
  | 'not_configured'
  | 'scrub_failed'
  | 'timeout'
  | 'http_error'
  | 'bad_response';

export class ClassifierUnavailableError extends Error {
  readonly reason: ClassifierUnavailableReason;

  constructor(reason: ClassifierUnavailableReason, message: string) {
    super(message);
    this.name = 'ClassifierUnavailableError';
    this.reason = reason;
  }
}
