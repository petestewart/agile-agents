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

  test('accepts the architect role (T031 — a singleton spawned session, not a per-ticket one)', () => {
    expect(() =>
      validateAgentRecord({
        vendor: 'claude',
        model: 'claude-sonnet-4-5',
        pid: 4242,
        last_seen: '2026-09-07T18:00:00Z',
        role: 'architect',
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
        role: 'em',
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

  // T012 review round 3 (opus item 3): `pid` is optional — a spawned
  // agent's real OS pid may not be known yet (a spawn failure, or a
  // registration racing the child's first tick), and every writer now
  // omits the field rather than falling back to the daemon's own pid.
  test('validates a record with no pid at all (T012 review round 3: never fall back to the daemon pid)', () => {
    expect(() =>
      validateAgentRecord({
        vendor: 'claude',
        model: 'claude-sonnet-4-5',
        last_seen: '2026-09-07T18:00:00Z',
      }),
    ).not.toThrow();
  });
});
