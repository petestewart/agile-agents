import { describe, expect, test } from 'bun:test';
import { MESSAGE_BODY_MAX_CHARS, validateAgentMessage } from './agent-message';

const base = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  ts: '2026-09-07T18:00:00Z',
  from: 'human',
  to: ['01BX5ZZKBKACTAV9WEVGEMMVRZ'],
  kind: 'hil_response',
  priority: 'normal',
  body: 'short body',
};

describe('AgentMessage schema', () => {
  test('validates a minimal hil_response', () => {
    expect(validateAgentMessage(base).refs).toEqual([]);
  });

  test('caps the body at 800 chars', () => {
    expect(() =>
      validateAgentMessage({ ...base, body: 'x'.repeat(MESSAGE_BODY_MAX_CHARS) }),
    ).not.toThrow();
    expect(() =>
      validateAgentMessage({ ...base, body: 'x'.repeat(MESSAGE_BODY_MAX_CHARS + 1) }),
    ).toThrow(/800/);
  });

  test('rejects the old team kinds, recipients and fields', () => {
    expect(() => validateAgentMessage({ ...base, kind: 'assign' })).toThrow();
    expect(() => validateAgentMessage({ ...base, to: ['broadcast'] })).toThrow();
    expect(() => validateAgentMessage({ ...base, to: ['em'] })).toThrow();
    expect(() => validateAgentMessage({ ...base, ticket: 'TKT-0231' })).toThrow();
    expect(() => validateAgentMessage({ ...base, requires_ack: true })).toThrow();
  });

  test('a hil_request must name its hil_kind', () => {
    const request = { ...base, kind: 'hil_request', priority: 'urgent' };
    expect(() => validateAgentMessage(request)).toThrow(/hil_kind/);
    expect(() => validateAgentMessage({ ...request, hil_kind: 'classifier_review' })).not.toThrow();
  });
});
