/**
 * Where the classifier tier is on (§6.4), most specific first: the
 * stream's `classifier: 'off'`, the repo's default, then the home config (a
 * provider other than `off`, and a key). The first two can only say off.
 * Off is never an error: it takes the same fail policy as an outage.
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
