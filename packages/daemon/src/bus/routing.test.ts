import { describe, expect, test } from 'bun:test';
import { checkRoute, roleOf } from './routing';

describe('roleOf', () => {
  test('maps fixed roles and numbered roles', () => {
    expect(roleOf('em')).toBe('em');
    expect(roleOf('architect')).toBe('architect');
    expect(roleOf('human')).toBe('human');
    expect(roleOf('daemon')).toBe('daemon');
    expect(roleOf('eng-3')).toBe('engineer');
    expect(roleOf('reviewer-1')).toBe('reviewer');
    expect(roleOf('qa-2')).toBe('qa');
  });

  test('throws on an unrecognized id', () => {
    expect(() => roleOf('nope')).toThrow();
  });
});

describe('checkRoute — allowed routes', () => {
  test('engineer -> em: question/discovery/escalate/standup_report', () => {
    for (const kind of ['question', 'discovery', 'escalate', 'standup_report'] as const) {
      expect(checkRoute({ from: 'eng-1', to: 'em', kind }).allowed).toBe(true);
    }
  });

  test('engineer -> reviewer: review_request', () => {
    expect(checkRoute({ from: 'eng-1', to: 'reviewer-1', kind: 'review_request' }).allowed).toBe(
      true,
    );
  });

  test('reviewer -> engineer: review_verdict', () => {
    expect(checkRoute({ from: 'reviewer-1', to: 'eng-1', kind: 'review_verdict' }).allowed).toBe(
      true,
    );
  });

  test('qa -> engineer: qa_verdict', () => {
    expect(checkRoute({ from: 'qa-1', to: 'eng-1', kind: 'qa_verdict' }).allowed).toBe(true);
  });

  test('reviewer/qa -> em: copy, any kind (including standup_report — a reviewer/qa can also be a halt-affected agent)', () => {
    expect(checkRoute({ from: 'reviewer-1', to: 'em', kind: 'review_verdict' }).allowed).toBe(true);
    expect(checkRoute({ from: 'qa-1', to: 'em', kind: 'qa_verdict' }).allowed).toBe(true);
    expect(checkRoute({ from: 'reviewer-1', to: 'em', kind: 'standup_report' }).allowed).toBe(true);
    expect(checkRoute({ from: 'qa-1', to: 'em', kind: 'standup_report' }).allowed).toBe(true);
  });

  test('architect -> em', () => {
    expect(checkRoute({ from: 'architect', to: 'em', kind: 'fyi' }).allowed).toBe(true);
  });

  test('architect -> ticket:*: decision', () => {
    expect(checkRoute({ from: 'architect', to: 'ticket:TKT-0001', kind: 'decision' }).allowed).toBe(
      true,
    );
  });

  test('architect -> broadcast: halt/resume', () => {
    expect(checkRoute({ from: 'architect', to: 'broadcast', kind: 'halt' }).allowed).toBe(true);
    expect(checkRoute({ from: 'architect', to: 'broadcast', kind: 'resume' }).allowed).toBe(true);
  });

  test('em -> anyone, any kind', () => {
    expect(checkRoute({ from: 'em', to: 'eng-1', kind: 'assign' }).allowed).toBe(true);
    expect(checkRoute({ from: 'em', to: 'qa-1', kind: 'assign' }).allowed).toBe(true);
    expect(checkRoute({ from: 'em', to: 'human', kind: 'fyi' }).allowed).toBe(true);
    expect(checkRoute({ from: 'em', to: 'broadcast', kind: 'halt' }).allowed).toBe(true);
  });

  test('human -> anyone, any kind', () => {
    expect(checkRoute({ from: 'human', to: 'eng-1', kind: 'answer', ...{} }).allowed).toBe(true);
  });

  test('anyone -> human: hil_request', () => {
    expect(checkRoute({ from: 'eng-1', to: 'human', kind: 'hil_request' }).allowed).toBe(true);
    expect(checkRoute({ from: 'architect', to: 'human', kind: 'hil_request' }).allowed).toBe(true);
  });

  test('daemon -> em, and daemon broadcast halt/resume', () => {
    expect(checkRoute({ from: 'daemon', to: 'em', kind: 'escalate' }).allowed).toBe(true);
    expect(checkRoute({ from: 'daemon', to: 'broadcast', kind: 'halt' }).allowed).toBe(true);
    expect(checkRoute({ from: 'daemon', to: 'broadcast', kind: 'resume' }).allowed).toBe(true);
  });
});

describe('checkRoute — disallowed routes (rejected with a reason)', () => {
  test('engineers never message each other directly', () => {
    const result = checkRoute({ from: 'eng-1', to: 'eng-2', kind: 'question' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/engineers never message each other/);
  });

  test('engineer -> qa directly is rejected (must go via em)', () => {
    const result = checkRoute({ from: 'eng-1', to: 'qa-1', kind: 'qa_verdict' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  test('engineer -> em with a non-question kind is rejected', () => {
    const result = checkRoute({ from: 'eng-1', to: 'em', kind: 'answer' });
    expect(result.allowed).toBe(false);
  });

  test('non-hil_request to human is rejected', () => {
    const result = checkRoute({ from: 'eng-1', to: 'human', kind: 'fyi' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/hil_request/);
  });

  test('broadcast from an engineer is rejected', () => {
    const result = checkRoute({ from: 'eng-1', to: 'broadcast', kind: 'halt' });
    expect(result.allowed).toBe(false);
  });

  test('broadcast of a non-halt/resume kind is rejected even from architect', () => {
    const result = checkRoute({ from: 'architect', to: 'broadcast', kind: 'fyi' });
    expect(result.allowed).toBe(false);
  });

  test('ticket:* from a non-architect is rejected', () => {
    const result = checkRoute({ from: 'eng-1', to: 'ticket:TKT-0001', kind: 'decision' });
    expect(result.allowed).toBe(false);
  });

  test('ticket:* with a non-decision kind from architect is rejected', () => {
    const result = checkRoute({ from: 'architect', to: 'ticket:TKT-0001', kind: 'fyi' });
    expect(result.allowed).toBe(false);
  });

  test('architect -> engineer directly is rejected', () => {
    const result = checkRoute({ from: 'architect', to: 'eng-1', kind: 'assign' });
    expect(result.allowed).toBe(false);
  });

  test('reviewer -> engineer with the wrong verdict kind is rejected', () => {
    const result = checkRoute({ from: 'reviewer-1', to: 'eng-1', kind: 'qa_verdict' });
    expect(result.allowed).toBe(false);
  });

  test('daemon -> anyone other than em/broadcast is rejected', () => {
    const result = checkRoute({ from: 'daemon', to: 'eng-1', kind: 'assign' });
    expect(result.allowed).toBe(false);
  });
});
