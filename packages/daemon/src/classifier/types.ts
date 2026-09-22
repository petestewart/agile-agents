/**
 * The classifier tier's interface (design/cockpit-design.md §6.2), verbatim:
 *
 * ```ts
 * interface Classifier { ask(state: string, questions: Noul[]): Promise<Answer[]> }
 * Noul   = { id: string, question: string }
 * Answer = { id: string, probability: number, confidence: number }
 * ```
 *
 * These types are **not persisted state** — a classifier call is a question
 * asked and answered inside one gated action, and nothing about it reaches
 * disk except the event T151 logs. So they live here as plain TypeScript
 * rather than as zod schemas in `packages/shared`; the config that *is*
 * persisted (`classifier:` in `config.yaml`, the per-repo default, the
 * per-stream opt-out) has its schemas there, as the convention requires.
 */

/** One yes/no question about the state. `id` is the rule's id in practice. */
export interface Noul {
  id: string;
  question: string;
}

/**
 * One answer, keyed back to the question's `id`.
 *
 * `probability` is "how likely is the answer yes" and `confidence` is "how
 * sure is the model of that" — two axes, because §6.3's bands read both: a
 * probability of 0.9 with confidence 0.2 is not a 0.9, it is a shrug.
 */
export interface Answer {
  id: string;
  probability: number;
  confidence: number;
}

/** What `onCall` is handed after every attempt, successful or not (§6.2, latency). */
export interface ClassifierCallInfo {
  /** Wall-clock time from entering `ask` to resolving or failing. */
  latency_ms: number;
  /** How many questions the call carried — one call per state, N questions. */
  questions: number;
  ok: boolean;
  /** Present when `ok` is false: the failure, already stringified. */
  error?: string;
}

/**
 * §6.2. One call per state, N questions: ten classifier rules in scope must
 * not mean ten round trips on every tool call.
 *
 * An implementation returns one `Answer` per `Noul`, in the order asked.
 * It throws `ClassifierUnavailableError` when it could not ask at all (no
 * key, the scrub failed, a timeout, a transport or protocol error) — the
 * caller then applies §6.4's fail policy rather than guessing.
 */
export interface Classifier {
  ask(state: string, questions: Noul[]): Promise<Answer[]>;
}

/**
 * The classifier could not answer. One error type for every reason, because
 * §6.4's fail policy does not distinguish between them: critical rules deny,
 * everything else proceeds with a `hook_unchecked` entry on the thread,
 * whether the key was missing, the scrub threw or the API timed out.
 *
 * `reason` is the machine-readable discriminator for the event T151 logs;
 * the message is what a human reads.
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
