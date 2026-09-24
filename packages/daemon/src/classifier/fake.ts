/**
 * `FakeClassifier`: the only classifier the test suite uses (§6.2; no
 * network in `bun test`). Scripted by a fixed `Answer[]`, a function per
 * call, or `throws`/`delayMs` for the fail policy and timeout. Every call
 * is recorded on `calls` (so a test can check the state was scrubbed).
 */

import type { Answer, Classifier, ClassifierCallInfo, Noul } from './types';

export interface FakeClassifierCall {
  state: string;
  questions: Noul[];
}

export type FakeScript = Answer[] | ((state: string, questions: Noul[]) => Answer[]);

export interface FakeClassifierOptions {
  /** Thrown instead of answering (§6.4). */
  throws?: Error;
  /** Resolves this long after `ask` is entered, before answering or throwing. */
  delayMs?: number;
  /** The same latency hook the real adapter takes. */
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
}
