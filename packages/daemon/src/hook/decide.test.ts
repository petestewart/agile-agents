import { describe, expect, test } from 'bun:test';
import type { Message } from '@agile-agents/shared';
import { decidePreToolUse } from './decide';
import { DEFAULT_MAX_READ_BYTES, type HookDecisionContext } from './types';

function baseCtx(overrides: Partial<HookDecisionContext> = {}): HookDecisionContext {
  return {
    session: '01J9AAAAAAAAAAAAAAAAAAAAAA',
    stream: '01J9BBBBBBBBBBBBBBBBBBBBBB',
    role: 'worker',
    worktreePath: '/repo/.worktrees/TKT-0001',
    inbox: [],
    limits: { maxReadBytes: DEFAULT_MAX_READ_BYTES },
    fileSize: () => undefined,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: '01J9000000000000000000000',
    ts: '2026-09-09T00:00:00Z',
    from: 'em',
    to: ['eng-1'],
    kind: 'answer',
    priority: 'normal',
    body: 'use the JWT approach',
    refs: [],
    requires_ack: false,
    promote_to: 'none',
    ...overrides,
  } as Message;
}

describe('decidePreToolUse — normal inbox is additive, never overrides the gate verdict (review round fix, blocker 1)', () => {
  const normal = makeMessage({ id: 'norm-1', priority: 'normal', body: 'use the JWT approach' });

  test('a pending normal message does NOT turn a big-read denial into an allow', () => {
    const ctx = baseCtx({ inbox: [normal], fileSize: () => 100 * 1024 });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Read',
      tool_input: { file_path: 'big.txt' },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/read_summary/);
    // Still delivered: attached to the deny output, and acked.
    expect(result.additionalContext).toContain('use the JWT approach');
    expect(result.ack).toEqual(['norm-1']);
  });

  test('a pending normal message does NOT turn a never-without-human ask into an allow', () => {
    const ctx = baseCtx({ inbox: [normal] });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main' },
    });
    expect(result.decision).toBe('ask');
    expect(result.additionalContext).toContain('use the JWT approach');
    expect(result.ack).toEqual(['norm-1']);
  });

  test('with nothing else to gate, a pending normal message still just allows + injects context', () => {
    const ctx = baseCtx({ inbox: [normal] });
    const result = decidePreToolUse(ctx, { tool_name: 'Read', tool_input: { file_path: 'x.txt' } });
    expect(result.decision).toBe('allow');
    expect(result.additionalContext).toContain('use the JWT approach');
    expect(result.ack).toEqual(['norm-1']);
  });
});

// Review round 3 (opus item 1): role × tool policy now reuses T010's whole
// `decidePermission` pipeline for edit-kind tools and `Bash`, for every
// role — not just a Bash-only `checkNeverWithoutHuman` branch that never
// consulted the role table at all. Every assertion below is a real
// `decision`/`reason` check, not a `void`d call.
describe('decidePreToolUse — role × tool policy (review round 3, reuses decidePermission)', () => {
  test('reviewer Edit/Write/MultiEdit/NotebookEdit all deny — reviewers are read-only', () => {
    const ctx = baseCtx({ role: 'reviewer', worktreePath: '/repo/.worktrees/TKT-0001' });
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const result = decidePreToolUse(ctx, {
        tool_name: tool,
        tool_input: { file_path: '/repo/.worktrees/TKT-0001/a.ts' },
      });
      expect(result.decision).toBe('deny');
      expect(result.reason).toMatch(/reviewer role denies all writes/);
    }
  });

  test('a generic tool reporting tool_input.kind === "edit" is gated the same as a named edit tool', () => {
    const ctx = baseCtx({ role: 'reviewer', worktreePath: '/repo/.worktrees/TKT-0001' });
    const result = decidePreToolUse(ctx, {
      tool_name: 'SomeMcpEditTool',
      tool_input: { kind: 'edit', file_path: '/repo/.worktrees/TKT-0001/a.ts' },
    });
    expect(result.decision).toBe('deny');
  });

  test('worker Edit inside its own worktree allows', () => {
    const ctx = baseCtx({ role: 'worker', worktreePath: '/repo/.worktrees/TKT-0001' });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/.worktrees/TKT-0001/a.ts' },
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  test('worker Edit outside its own worktree denies', () => {
    const ctx = baseCtx({ role: 'worker', worktreePath: '/repo/.worktrees/TKT-0001' });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/other-ticket/a.ts' },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/outside the worktree/);
  });

  test('reviewer Bash: read-only allow-list (git diff) allows, everything else (rm -rf) denies', () => {
    const ctx = baseCtx({ role: 'reviewer', worktreePath: '/repo/.worktrees/TKT-0001' });
    const readOnly = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'git diff' },
    });
    expect(readOnly).toEqual({ decision: 'allow' });

    const destructive = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf src' },
    });
    expect(destructive.decision).toBe('deny');
    expect(destructive.reason).toMatch(/reviewer role denies all exec/);
  });

  test('a Read/Grep/Glob is never routed through the role table — untouched by this round', () => {
    const ctx = baseCtx({ role: 'reviewer', worktreePath: '/repo/.worktrees/TKT-0001' });
    const read = decidePreToolUse(ctx, {
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(read).toEqual({ decision: 'allow' });
    const glob = decidePreToolUse(ctx, { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } });
    expect(glob).toEqual({ decision: 'allow' });
  });
});
