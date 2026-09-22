/**
 * `FakeClassifier` — §6.2's "scripted per test, and the only classifier the
 * suite ever uses". There is no network in `bun test`; the one place the
 * real wire shape is checked is the recorded-fixture test.
 *
 * It scripts three ways, because T151's bands, error path and timeout path
 * each need a different one:
 *
 *  - a fixed `Answer[]`, returned for every call;
 *  - a function `(state, questions) => Answer[]`, for a band per question;
 *  - `throws` / `delayMs`, for the fail policy (§6.4) and the timeout.
 *
 * Every call is recorded on `calls`, so a test can assert what the hook
 * actually sent — including that it sent the *scrubbed* state.
 */

import type { Answer, Classifier, ClassifierCallInfo, Noul } from './types';

export interface FakeClassifierCall {
  state: string;
  questions: Noul[];
}

export type FakeScript = Answer[] | ((state: string, questions: Noul[]) => Answer[]);

export interface FakeClassifierOptions {
  /** Thrown instead of answering — the §6.4 error path. */
  throws?: Error;
  /** Resolves this long after `ask` is entered, before answering or throwing. */
  delayMs?: number;
  /** Same latency hook the real adapter takes, so T151 can test its event. */
  onCall?: (info: ClassifierCallInfo) => void;
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

  /** Re-scripts between calls — a second round with different answers. */
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
}
