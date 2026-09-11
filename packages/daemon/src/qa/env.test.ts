import { describe, expect, test } from 'bun:test';
import { validateTicket } from '@agile-agents/shared';
import { QaEnvUnsupportedError, resolveQaEnv } from './env';

function makeTicket(env: string) {
  return validateTicket({
    id: 'TKT-0001',
    title: 'Fixture',
    status: 'in_qa',
    contract: { env },
    history: [],
  });
}

describe('resolveQaEnv', () => {
  test('clone env resolves to the given worktree path', () => {
    const env = resolveQaEnv(makeTicket('clone'), '/tmp/x-qa');
    expect(env).toEqual({ kind: 'clone', worktreePath: '/tmp/x-qa' });
  });

  test('compose env refuses with a clear DESIGN-GAP error', () => {
    expect(() => resolveQaEnv(makeTicket('compose: docker/compose.test.yml'), '/tmp/x-qa')).toThrow(
      QaEnvUnsupportedError,
    );
  });
});
