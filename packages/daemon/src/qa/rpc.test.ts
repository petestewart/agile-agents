import { describe, expect, test } from 'bun:test';
import { QaRpcParamError, buildQaRpcMethods } from './rpc';

function fakeProtocol(status: unknown) {
  return { status: () => status } as never;
}

describe('buildQaRpcMethods', () => {
  test('qa.status returns the protocol status for a valid ticket id', () => {
    const methods = buildQaRpcMethods(
      fakeProtocol({ round: 2, criteriaCount: 3, plannedCount: 1, ranCount: 0 }),
    );
    expect(methods['qa.status']?.({ ticket: 'TKT-0001' })).toEqual({
      round: 2,
      criteriaCount: 3,
      plannedCount: 1,
      ranCount: 0,
    });
  });

  test('qa.status returns null when no round is active', () => {
    const methods = buildQaRpcMethods(fakeProtocol(undefined));
    expect(methods['qa.status']?.({ ticket: 'TKT-0001' })).toBeNull();
  });

  test('qa.status rejects a malformed ticket id', () => {
    const methods = buildQaRpcMethods(fakeProtocol(undefined));
    expect(() => methods['qa.status']?.({ ticket: 'not-a-ticket' })).toThrow(QaRpcParamError);
  });

  test('qa.status rejects non-object params', () => {
    const methods = buildQaRpcMethods(fakeProtocol(undefined));
    expect(() => methods['qa.status']?.('nope')).toThrow(QaRpcParamError);
  });
});
