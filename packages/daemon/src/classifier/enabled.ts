/**
 * Where the classifier tier is on, and where it is off
 * (design/cockpit-design.md §6.4).
 *
 * Three levels, most specific first:
 *
 *  1. the **stream**'s own `classifier: 'off'` — "a stream working on
 *     something the operator does not want leaving the machine turns the
 *     tier off";
 *  2. the **repo**'s default in `repos.yaml`;
 *  3. the **home** config: a provider other than `off`, and a key.
 *
 * Only step 1 and 2 can say *off* against a configured home; neither can
 * say *on* against an unconfigured one, because there is nothing to call.
 * Turning the tier off is never an error: §6.4 covers it with the same fail
 * policy as an outage — "the same policy covers the opt-out and a missing
 * key" — so a critical rule still denies and everything else proceeds with
 * a `hook_unchecked` entry on the thread.
 */

import type { ClassifierConfig, RepoEntry, Stream } from '@agile-agents/shared';
import { TYPESAFE_API_KEY_ENV } from './jev';

export interface ClassifierEnabledInput {
  /** The stream the gated action belongs to, when there is one. */
  stream?: Pick<Stream, 'classifier'> | undefined;
  /** The stream's entry in `repos.yaml`, when the stream has a repo. */
  repo?: Pick<RepoEntry, 'classifier'> | undefined;
  /** `classifier:` from `<home>/config.yaml`. */
  config: ClassifierConfig;
  /** Key lookup for the home level. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** True when a classifier call should be made for this stream. */
export function classifierEnabled(input: ClassifierEnabledInput): boolean {
  if (input.stream?.classifier === 'off') return false;
  if (input.repo?.classifier === 'off') return false;
  if (input.config.provider === 'off') return false;
  const env = input.env ?? process.env;
  return (input.config.api_key ?? (env[TYPESAFE_API_KEY_ENV] || undefined)) !== undefined;
}
