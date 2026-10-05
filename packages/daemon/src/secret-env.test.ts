/** T486: the classifier key never reaches a process the daemon starts for a vendor. */

import { describe, expect, test } from 'bun:test';
import { DAEMON_ONLY_ENV_NAMES, withoutDaemonSecrets } from './secret-env';

describe('T486: withoutDaemonSecrets', () => {
  test('drops TYPESAFE_API_KEY and keeps everything else, logins included', () => {
    expect(DAEMON_ONLY_ENV_NAMES).toEqual(['TYPESAFE_API_KEY']);
    expect(
      withoutDaemonSecrets({
        HOME: '/h',
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'vendor-login',
        TYPESAFE_API_KEY: 'not-a-real-key',
        UNSET: undefined,
      }),
    ).toEqual({ HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'vendor-login' });
  });
});
