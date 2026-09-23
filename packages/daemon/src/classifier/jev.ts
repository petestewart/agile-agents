/**
 * `JevClassifier`: the classifier tier's one real implementation (§6.2,
 * D5). The daemon holds the TypeSafe key, the one written exception to
 * "no vendor credentials in the daemon": the classifier is the daemon's
 * own dependency, not an agent's. `fetch`, `now` and `scrub` are test
 * seams; tests never reach the network.
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

/** The env var the key comes from when `config.yaml` names none. */
export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY';

export interface JevClassifierOptions {
  /** `classifier:` from `config.yaml`, through the schema. */
  config: ClassifierConfig;
  /** Key fallback env. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Test seams. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** A test can inject a scrub that throws (§6.5). */
  scrub?: (state: string) => string;
  /** Called once per `ask`, success or failure, with the latency (§6.2). */
  onCall?: (info: ClassifierCallInfo) => void;
}

export class JevClassifier implements Classifier {
  private readonly config: ClassifierConfig;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly scrub: (state: string) => string;
  private readonly onCall: ((info: ClassifierCallInfo) => void) | undefined;

  constructor(options: JevClassifierOptions) {
    this.config = options.config;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.scrub = options.scrub ?? defaultScrub;
    this.onCall = options.onCall;
  }

  /** Read per call, so a key set or removed in Settings applies without a restart. */
  private get apiKey(): string | undefined {
    // An empty env var is no key (a shell that exported `TYPESAFE_API_KEY=`).
    return this.config.api_key ?? (this.env[TYPESAFE_API_KEY_ENV] || undefined);
  }

  /** A provider that isn't `off` and a key from somewhere. `ask` throws regardless. */
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
    // Zero questions is no call (ten rules are one round trip, §6.2).
    if (questions.length === 0) return [];

    // §6.5, fail-closed: if the scrub throws, nothing is sent.
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
