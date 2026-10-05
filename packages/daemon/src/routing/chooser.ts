/**
 * T483 (design/model-routing.md §5, D52): the chooser. One Jev call with
 * the choice primitive per routed pick: the five criteria, the topic, the
 * model (the preset models) and the effort. It returns a reading, or why
 * there is none (no key; a 401, 429, timeout or bad reply), and never
 * throws: the pick falls back to the rule and the chat line says why.
 *
 * The call is bounded by the classifier's own timeout, so a slow Jev never
 * holds a start for longer than a rule check would.
 */

import {
  type ChoiceQuestion,
  type ChooserOutcome,
  ChooserReadError,
  type ChooserTask,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  type ModelPolicy,
  type ModelProfile,
  type PickCatalogModel,
  type PresetModel,
  buildChooserState,
  chooserQuestions,
  readChooserAnswers,
} from '@agile-agents/shared';
import { type Classifier, ClassifierUnavailableError } from '../classifier';

export interface ModelChooserOptions {
  /** The daemon's classifier tier (read per call). Absent: there is no key. */
  classifier?: Classifier | (() => Classifier | undefined);
  /** How long a start waits for Jev (default: the classifier's own timeout). */
  timeoutMs?: number | (() => number);
  now?: () => number;
}

export interface ChooserReadInput {
  task: ChooserTask;
  policy: ModelPolicy;
  candidates: readonly PresetModel[];
  profiles: Readonly<Record<string, ModelProfile>>;
  models?: Readonly<Partial<Record<string, readonly PickCatalogModel[]>>>;
  need: 'topic' | 'full';
}

export interface ChooserCall {
  outcome: ChooserOutcome;
  /** What was asked (Try it and the tests look). */
  questions: ChoiceQuestion[];
  state: string;
  latency_ms: number;
}

class ChooserTimeout extends Error {}

export class ModelChooser {
  private readonly now: () => number;

  constructor(private readonly options: ModelChooserOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private classifier(): Classifier | undefined {
    const c = this.options.classifier;
    return typeof c === 'function' ? c() : c;
  }

  private timeoutMs(): number {
    const t = this.options.timeoutMs;
    return (typeof t === 'function' ? t() : t) ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
  }

  /** One call; a reading, or why there is none. Never throws. */
  async read(input: ChooserReadInput): Promise<ChooserCall> {
    const started = this.now();
    const questions = chooserQuestions({
      policy: input.policy,
      candidates: input.candidates,
      profiles: input.profiles,
      ...(input.models !== undefined ? { models: input.models } : {}),
      need: input.need,
    });
    const state = buildChooserState(input.task);
    const done = (outcome: ChooserOutcome): ChooserCall => ({
      outcome,
      questions,
      state,
      latency_ms: this.now() - started,
    });
    const classifier = this.classifier();
    if (classifier === undefined) {
      return done({ ok: false, reason: 'no_key', detail: 'no classifier' });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ChooserTimeout()), this.timeoutMs());
      });
      const answers = await Promise.race([classifier.choose(state, questions), timeout]);
      return done({ ok: true, reading: readChooserAnswers(questions, answers) });
    } catch (error) {
      if (error instanceof ClassifierUnavailableError && error.reason === 'not_configured') {
        return done({ ok: false, reason: 'no_key', detail: error.message });
      }
      const detail =
        error instanceof ChooserTimeout
          ? `timed out after ${this.timeoutMs()}ms`
          : error instanceof ChooserReadError || error instanceof Error
            ? error.message
            : String(error);
      return done({ ok: false, reason: 'no_answer', detail: detail.slice(0, 300) });
    } finally {
      clearTimeout(timer);
    }
  }
}
