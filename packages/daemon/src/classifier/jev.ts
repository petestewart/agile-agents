/**
 * `JevClassifier` — the classifier tier's one real implementation
 * (design/cockpit-design.md §6.2, **D5**).
 *
 * The daemon holds the `TYPESAFE_API_KEY`. That is the narrow, written-down
 * exception to "no vendor credentials in the daemon": every other
 * credential here belongs to a *coding agent*, and the adapters spawn
 * vendor harnesses under the user's own login precisely so the daemon never
 * holds one. The classifier is the daemon's own dependency, not an agent's.
 *
 * Three seams, all for tests: `fetch`, `now`, and `scrub`. The suite never
 * reaches the network — `FakeClassifier` is the only classifier the rest of
 * the tests use, and the fixture test in `jev.test.ts` pins the request and
 * response shapes against recorded JSON.
 */

import type { ClassifierConfig } from '@agile-agents/shared';
import { buildJevRequest, jevEndpoint, parseJevResponse } from './jev-wire';
import { scrub as defaultScrub } from './scrub';
import {
  type Answer,
  type Classifier,
  type ClassifierCallInfo,
  ClassifierUnavailableError,
  type Noul,
} from './types';

/** The env var the key comes from when `config.yaml` names none (§6.2). */
export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY';

export interface JevClassifierOptions {
  /** `classifier:` from `<home>/config.yaml`, already through the schema. */
  config: ClassifierConfig;
  /** Falls back to `process.env.TYPESAFE_API_KEY` when the config names no key. */
  env?: Record<string, string | undefined>;
  /** Injectable transport. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Injectable clock for the latency measurement. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable scrub, so a test can inject one that throws (§6.5). */
  scrub?: (state: string) => string;
  /**
   * Called once per `ask`, success or failure, with the measured latency.
   * §6.2: "latency is recorded per call as an event, because a gate that
   * adds a second to every tool call is a gate that will be turned off."
   * T151 passes the daemon's event writer here; nothing is logged from
   * inside the adapter itself.
   */
  onCall?: (info: ClassifierCallInfo) => void;
}

export class JevClassifier implements Classifier {
  private readonly config: ClassifierConfig;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly scrub: (state: string) => string;
  private readonly onCall: ((info: ClassifierCallInfo) => void) | undefined;

  constructor(options: JevClassifierOptions) {
    this.config = options.config;
    const env = options.env ?? process.env;
    this.apiKey = options.config.api_key ?? env[TYPESAFE_API_KEY_ENV] ?? undefined;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.scrub = options.scrub ?? defaultScrub;
    this.onCall = options.onCall;
  }

  /**
   * True when this classifier could actually make a call — a provider that
   * is not `off` and a key from somewhere. `ask` throws rather than relying
   * on the caller checking first, but T151's resolution reads this to
   * decide whether the tier exists at all.
   */
  get configured(): boolean {
    return this.config.provider !== 'off' && this.apiKey !== undefined;
  }

  async ask(state: string, questions: Noul[]): Promise<Answer[]> {
    const started = this.now();
    try {
      const answers = await this.call(state, questions);
      this.onCall?.({ latency_ms: this.now() - started, questions: questions.length, ok: true });
      return answers;
    } catch (error) {
      this.onCall?.({
        latency_ms: this.now() - started,
        questions: questions.length,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async call(state: string, questions: Noul[]): Promise<Answer[]> {
    if (this.config.provider === 'off') {
      throw new ClassifierUnavailableError('not_configured', 'classifier provider is "off"');
    }
    if (this.apiKey === undefined) {
      throw new ClassifierUnavailableError(
        'not_configured',
        `no classifier API key: set classifier.api_key in config.yaml or ${TYPESAFE_API_KEY_ENV}`,
      );
    }
    // An empty question list is not a call. Ten rules in scope are one round
    // trip (§6.2); zero rules in scope are none.
    if (questions.length === 0) return [];

    // §6.5, fail-closed: the scrub runs before every call, and if it throws
    // nothing is sent — not a partial state, not the unscrubbed state.
    let scrubbed: string;
    try {
      scrubbed = this.scrub(state);
    } catch (error) {
      throw new ClassifierUnavailableError(
        'scrub_failed',
        `credential scrub failed, nothing sent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const body = buildJevRequest(scrubbed, questions);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout_ms);
    let response: Response;
    try {
      response = await this.fetchImpl(jevEndpoint(this.config.base_url), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // An abort is the timeout firing; anything else is the transport.
      if (controller.signal.aborted) {
        throw new ClassifierUnavailableError(
          'timeout',
          `classifier call timed out after ${this.config.timeout_ms}ms`,
        );
      }
      throw new ClassifierUnavailableError(
        'http_error',
        `classifier call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new ClassifierUnavailableError(
        'http_error',
        `classifier call returned HTTP ${response.status}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new ClassifierUnavailableError(
        'bad_response',
        `classifier response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseJevResponse(parsed, questions);
  }
}
