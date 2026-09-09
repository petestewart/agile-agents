import { describe, expect, test } from 'bun:test';
import { validateAgentRecord } from './agents';

describe('AgentRecord schema', () => {
  test('validates a minimal legal record (idle agent, no ticket)', () => {
    expect(() =>
      validateAgentRecord({
        vendor: 'claude',
        model: 'claude-sonnet-4-5',
        pid: 4242,
        last_seen: '2026-09-07T18:00:00Z',
      }),
    ).not.toThrow();
  });

  test('validates a busy agent with a ticket', () => {
    expect(() =>
      validateAgentRecord({
        vendor: 'claude',
        model: 'claude-sonnet-4-5',
        ticket: 'TKT-0231',
        pid: 4242,
        last_seen: '2026-09-07T18:00:00Z',
      }),
    ).not.toThrow();
  });

  test('rejects an unknown key', () => {
    expect(() =>
      validateAgentRecord({
        vendor: 'claude',
        model: 'claude-sonnet-4-5',
        pid: 4242,
        last_seen: '2026-09-07T18:00:00Z',
        typo_field: 'x',
      }),
    ).toThrow();
  });

  test('validates the T012 additive fields (role/worktree/session_id)', () => {
    expect(() =>
      validateAgentRecord({
        vendor: 'claude',
        model: 'claude-sonnet-4-5',
        ticket: 'TKT-0231',
        pid: 4242,
        last_seen: '2026-09-07T18:00:00Z',
        role: 'engineer',
        worktree: '.worktrees/TKT-0231',
        session_id: 'sess-abc123',
      }),
    ).not.toThrow();
  });

  test('rejects an unknown role', () => {
    expect(() =>
      validateAgentRecord({
        vendor: 'claude',
        model: 'claude-sonnet-4-5',
        pid: 4242,
        last_seen: '2026-09-07T18:00:00Z',
        role: 'architect',
      }),
    ).toThrow();
  });

  test('rejects a malformed ticket id and a non-positive pid', () => {
    expect(() =>
      validateAgentRecord({
        vendor: 'claude',
        model: 'claude-sonnet-4-5',
        ticket: 'not-a-ticket',
        pid: 4242,
        last_seen: '2026-09-07T18:00:00Z',
      }),
    ).toThrow();
    expect(() =>
      validateAgentRecord({
        vendor: 'claude',
        model: 'claude-sonnet-4-5',
        pid: 0,
        last_seen: '2026-09-07T18:00:00Z',
      }),
    ).toThrow();
  });
});
