/** T320: a tracker port from `config.yaml`'s `trackers:` block, or a clear "not configured". */

import type { TrackerSystem, TrackersConfig } from '@agile-agents/shared';
import { createJira } from './jira';
import { createLinear } from './linear';
import { TrackerError, type TrackerPort } from './port';

export function trackerFromConfig(
  system: TrackerSystem,
  config: TrackersConfig | undefined,
): TrackerPort {
  const notConfigured = () =>
    new TrackerError(
      `${system} is not configured: set trackers.${system}.token in config.yaml`,
      'auth',
    );
  if (system === 'jira') {
    const c = config?.jira;
    if (!c?.token) throw notConfigured();
    return createJira({
      base_url: c.base_url,
      token: c.token,
      ...(c.email ? { email: c.email } : {}),
    });
  }
  const c = config?.linear;
  if (!c?.token) throw notConfigured();
  return createLinear({ api_url: c.api_url, token: c.token });
}
