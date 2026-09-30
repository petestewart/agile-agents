/**
 * `FakeClassifier`: the only classifier the test suite uses (§6.2; no
 * network in `bun test`). Scripted by a fixed `Answer[]`, a function per
 * call, or `throws`/`delayMs` for the fail policy and timeout. Every call
 * is recorded on `calls` (so a test can check the state was scrubbed).
 */

import {
  type Answer,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type Classifier,
  type ClassifierCallInfo,
  ClassifierUnavailableError,
  type Noul,
} from './types';

export interface FakeClassifierCall {
  state: string;
  questions: Noul[];
}

export type FakeScript = Answer[] | ((state: string, questions: Noul[]) => Answer[]);

/** T483: one choice call as asked. */
export interface FakeChoiceCall {
  state: string;
  questions: ChoiceQuestion[];
}

/**
 * T483: the choice answers, by question id (`{model: {choice, confidence,
 * probabilities}}`), or a function per call. A question left out gets no
 * answer (a bad response, as from the real API).
 */
export type FakeChoiceScript =
  | Record<string, Omit<ChoiceAnswer, 'id'>>
  | ((state: string, questions: ChoiceQuestion[]) => ChoiceAnswer[]);

export interface FakeClassifierOptions {
  /** Thrown instead of answering (§6.4). */
  throws?: Error;
  /** Resolves this long after `ask` is entered, before answering or throwing. */
  delayMs?: number;
  /** The same latency hook the real adapter takes. */
  onCall?: (info: ClassifierCallInfo) => void;
  /**
   * T483: how `choose` answers. Absent: it throws `not_configured`, as a
   * daemon with no key would (the chooser's "no classifier key").
   */
  choice?: FakeChoiceScript;
}

export class FakeClassifier implements Classifier {
  /** Every `ask`, in order, including ones that went on to throw. */
  readonly calls: FakeClassifierCall[] = [];
  private script: FakeScript;
  private options: FakeClassifierOptions;

  constructor(script: FakeScript = [], options: FakeClassifierOptions = {}) {
    this.script = script;
    this.options = options;
  }

  /** T483: every `choose`, in order, including ones that went on to throw. */
  readonly choiceCalls: FakeChoiceCall[] = [];

  /** Re-scripts between calls. */
  setScript(script: FakeScript, options: FakeClassifierOptions = {}): void {
    this.script = script;
    this.options = options;
  }

  async ask(state: string, questions: Noul[]): Promise<Answer[]> {
    this.calls.push({ state, questions: [...questions] });
    const started = Date.now();
    if (this.options.delayMs !== undefined && this.options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
    const report = (ok: boolean, error?: string): void => {
      this.options.onCall?.({
        latency_ms: Date.now() - started,
        questions: questions.length,
        ok,
        ...(error !== undefined ? { error } : {}),
      });
    };
    if (this.options.throws) {
      report(false, this.options.throws.message);
      throw this.options.throws;
    }
    const answers =
      typeof this.script === 'function' ? this.script(state, questions) : [...this.script];
    report(true);
    return answers;
  }

  /** T483: scripted choice answers (`options.choice`), with the same `throws` and `delayMs`. */
  async choose(state: string, questions: ChoiceQuestion[]): Promise<ChoiceAnswer[]> {
    this.choiceCalls.push({ state, questions: [...questions] });
    if (this.options.delayMs !== undefined && this.options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
    if (this.options.throws) throw this.options.throws;
    const script = this.options.choice;
    if (script === undefined) {
      throw new ClassifierUnavailableError('not_configured', 'no classifier key (a fake)');
    }
    if (typeof script === 'function') return script(state, questions);
    const out: ChoiceAnswer[] = [];
    for (const q of questions) {
      const answer = script[q.id];
      if (answer === undefined) {
        throw new ClassifierUnavailableError(
          'bad_response',
          `classifier response has no answer for "${q.id}"`,
        );
      }
      out.push({ id: q.id, ...answer });
    }
    return out;
  }
}
