import { describe, expect, test } from 'bun:test';
import type { Halt, Message } from '@agile-agents/shared';
import { decidePreToolUse } from './decide';
import { DEFAULT_MAX_READ_BYTES, type HookDecisionContext } from './types';

function baseCtx(overrides: Partial<HookDecisionContext> = {}): HookDecisionContext {
  return {
    agent: 'eng-1',
    ticket: 'TKT-0001',
    role: 'engineer',
    worktreePath: '/repo/.worktrees/TKT-0001',
    halts: [],
    inbox: [],
    ticketBudget: undefined,
    limits: { maxReadBytes: DEFAULT_MAX_READ_BYTES },
    fileSize: () => undefined,
    ...overrides,
  };
}

function makeHalt(overrides: Partial<Halt> = {}): Halt {
  return {
    id: 'H-1',
    scope: 'global',
    reason: 'discovery: auth model changed',
    raised_by: 'architect',
    quorum: 'pending',
    affected: [],
    reported: [],
    ...overrides,
  } as Halt;
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

describe('decidePreToolUse — order of precedence', () => {
  test('1b. the architect is exempt from halt denials — it raised the halt and must be able to release it', () => {
    const decision = decidePreToolUse(
      baseCtx({
        agent: 'architect',
        role: 'architect',
        worktreePath: '/repo/.worktrees/architect',
        halts: [
          makeHalt({ reason: 'SPEC-tasks-002 contradicts itself — architect ruling needed' }),
        ],
      }),
      {
        cwd: '/repo/.worktrees/architect',
        tool_name: 'mcp__agile__decision_publish',
        tool_input: {},
      },
    );
    expect(decision.decision).not.toBe('deny');
  });

  test('1. a halt covering the ticket denies with the halt reason, ahead of everything else', () => {
    const ctx = baseCtx({
      halts: [makeHalt({ reason: 'AGILE-HALT: auth model changed, stand down' })],
      inbox: [makeMessage({ priority: 'urgent', body: 'should never be seen' })],
    });
    const result = decidePreToolUse(ctx, { tool_name: 'Read' });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain(
      'halt H-1 (global): AGILE-HALT: auth model changed, stand down',
    );
    // The urgent message is never surfaced (tier 1 pre-empts tier 2)...
    expect(result.reason).not.toContain('should never be seen');
    // ...and the deny tells the agent how to get the halt released.
    expect(result.reason).toContain('kind: "standup_report"');
    expect(result.reason).toContain('refs: ["H-1"]');
    expect(result.ack).toBeUndefined();
  });

  describe('1a. under a halt the standup_report is the one call still allowed', () => {
    const halted = () => baseCtx({ halts: [makeHalt({ id: 'H-7' } as Partial<Halt>)] });
    const busSend = (input: Record<string, unknown>) => ({
      tool_name: 'mcp__agile__bus_send',
      tool_input: input,
    });

    test('a standup_report naming the halt in refs is allowed', () => {
      const result = decidePreToolUse(
        halted(),
        busSend({ to: ['em'], kind: 'standup_report', refs: ['H-7'], body: 'stashed WIP' }),
      );
      expect(result).toEqual({ decision: 'allow' });
    });

    test('a standup_report without the halt ref is denied with the shape to send — the EM cannot fold it otherwise', () => {
      const result = decidePreToolUse(
        halted(),
        busSend({ to: ['em'], kind: 'standup_report', body: 'stashed WIP' }),
      );
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('refs: ["H-7"]');
    });

    test('any other bus_send is still denied under the halt', () => {
      const result = decidePreToolUse(
        halted(),
        busSend({ to: ['em'], kind: 'question', refs: ['H-7'], body: 'can I continue?' }),
      );
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('halt H-7');
    });

    test("the halt's own urgent standup_call is acked by the tier-1 decision, so it cannot deny the agent again after release", () => {
      const call = makeMessage({
        id: 'call-1',
        kind: 'standup_call',
        priority: 'urgent',
        refs: ['H-7'],
        body: 'halt H-7 (global): ...',
      });
      const other = makeMessage({
        id: 'other-1',
        kind: 'standup_call',
        priority: 'urgent',
        refs: ['H-2'],
      });
      const ctx = baseCtx({
        halts: [makeHalt({ id: 'H-7' } as Partial<Halt>)],
        inbox: [call, other],
      });
      expect(
        decidePreToolUse(ctx, { tool_name: 'Bash', tool_input: { command: 'git stash' } }).ack,
      ).toEqual(['call-1']);
      expect(
        decidePreToolUse(
          ctx,
          busSend({ to: ['em'], kind: 'standup_report', refs: ['H-7'], body: 'x' }),
        ),
      ).toEqual({ decision: 'allow', ack: ['call-1'] });
    });
  });

  test('2. an urgent unacked message denies with the message body as the reason, and marks it for ack', () => {
    const urgent = makeMessage({
      id: 'urgent-1',
      priority: 'urgent',
      kind: 'halt',
      body: 'STOP: standup called',
    });
    const ctx = baseCtx({ inbox: [urgent] });
    const result = decidePreToolUse(ctx, { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('STOP: standup called');
    expect(result.ack).toEqual(['urgent-1']);
  });

  test('3. normal inbox allows and injects additionalContext, acking every normal message', () => {
    const a = makeMessage({ id: 'norm-1', priority: 'normal', body: 'answer A' });
    const b = makeMessage({ id: 'norm-2', priority: 'normal', body: 'answer B' });
    const ctx = baseCtx({ inbox: [a, b] });
    const result = decidePreToolUse(ctx, { tool_name: 'Read', tool_input: { file_path: 'x.txt' } });
    expect(result.decision).toBe('allow');
    expect(result.additionalContext).toContain('answer A');
    expect(result.additionalContext).toContain('answer B');
    expect(result.ack).toEqual(['norm-1', 'norm-2']);
  });

  test('4. a big raw Read is denied, pointing at read_summary', () => {
    const ctx = baseCtx({ fileSize: () => 100 * 1024 });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Read',
      tool_input: { file_path: 'big.txt' },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/read_summary\(path, question\)/);
    expect(result.reason).toMatch(/big\.txt/);
  });

  test('4b. a small raw Read is allowed', () => {
    const ctx = baseCtx({ fileSize: () => 100 });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Read',
      tool_input: { file_path: 'small.txt' },
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  test('4c. Grep over a directory (no resolvable file size) is allowed, never size-gated', () => {
    const ctx = baseCtx({ fileSize: () => undefined });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Grep',
      tool_input: { pattern: 'foo', path: 'src/' },
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  test('4d. Grep over a huge single file is denied', () => {
    const ctx = baseCtx({ fileSize: () => 200 * 1024 });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Grep',
      tool_input: { pattern: 'foo', path: 'huge.log' },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/read_summary/);
  });

  test('5. budget exceeded denies', () => {
    const ctx = baseCtx({ ticketBudget: { ceiling_tokens: 1000, spent_tokens: 1000 } });
    const result = decidePreToolUse(ctx, { tool_name: 'Read', tool_input: { file_path: 'x.txt' } });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/budget exhausted/);
  });

  test('5b. budget under ceiling allows', () => {
    const ctx = baseCtx({ ticketBudget: { ceiling_tokens: 1000, spent_tokens: 500 } });
    const result = decidePreToolUse(ctx, { tool_name: 'Read', tool_input: { file_path: 'x.txt' } });
    expect(result).toEqual({ decision: 'allow' });
  });

  test('6. git push origin main via Bash is never-without-human -> ask, with a reason', () => {
    const ctx = baseCtx({ ticket: 'TKT-0001' });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });
    expect(result.decision).toBe('ask');
    expect(result.reason).toMatch(/not this ticket's branch/);
  });

  test('6b. an ordinary Bash command (repo script) allows', () => {
    const ctx = baseCtx();
    const result = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'bun test' },
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  test('6c. sudo via Bash is never-without-human -> ask', () => {
    const ctx = baseCtx();
    const result = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'sudo rm -rf /' },
    });
    expect(result.decision).toBe('ask');
  });

  test('7. an unrelated tool with nothing to gate allows', () => {
    const ctx = baseCtx();
    const result = decidePreToolUse(ctx, { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } });
    expect(result).toEqual({ decision: 'allow' });
  });
});

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

  test('a pending normal message does NOT turn a budget denial into an allow', () => {
    const ctx = baseCtx({
      inbox: [normal],
      ticketBudget: { ceiling_tokens: 1000, spent_tokens: 1000 },
    });
    const result = decidePreToolUse(ctx, { tool_name: 'Read', tool_input: { file_path: 'x.txt' } });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/budget exhausted/);
    expect(result.additionalContext).toContain('use the JWT approach');
    expect(result.ack).toEqual(['norm-1']);
  });

  test('a pending normal message does NOT turn a never-without-human ask into an allow', () => {
    const ctx = baseCtx({ inbox: [normal] });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
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

  test('QA Edit denies — QA writes test files only, not source', () => {
    const ctx = baseCtx({ role: 'qa', worktreePath: '/repo/.worktrees/TKT-0001-qa' });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/.worktrees/TKT-0001-qa/src.ts' },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/QA role denies edits to source/);
  });

  test('a generic tool reporting tool_input.kind === "edit" is gated the same as a named edit tool', () => {
    const ctx = baseCtx({ role: 'reviewer', worktreePath: '/repo/.worktrees/TKT-0001' });
    const result = decidePreToolUse(ctx, {
      tool_name: 'SomeMcpEditTool',
      tool_input: { kind: 'edit', file_path: '/repo/.worktrees/TKT-0001/a.ts' },
    });
    expect(result.decision).toBe('deny');
  });

  test('engineer Edit inside its own worktree allows', () => {
    const ctx = baseCtx({ role: 'engineer', worktreePath: '/repo/.worktrees/TKT-0001' });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/.worktrees/TKT-0001/a.ts' },
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  test('engineer Edit outside its own worktree denies', () => {
    const ctx = baseCtx({ role: 'engineer', worktreePath: '/repo/.worktrees/TKT-0001' });
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

describe('T017 review round: QA contract-input/output deny-list seam (ctx.denyReadPaths)', () => {
  const QA_WORKTREE = '/repo/.worktrees/TKT-0001-qa';

  function qaCtx(denyReadPaths: string[]): HookDecisionContext {
    return baseCtx({ role: 'qa', worktreePath: QA_WORKTREE, denyReadPaths });
  }

  test('QA Read of an ABSOLUTE path under the clone matching a repo-relative contract glob denies (round-1 bug: absolute vs. repo-relative never matched)', () => {
    const ctx = qaCtx(['spec/input.md']);
    const result = decidePreToolUse(ctx, {
      tool_name: 'Read',
      tool_input: { file_path: `${QA_WORKTREE}/spec/input.md` },
    });
    expect(result).toEqual({
      decision: 'deny',
      reason: 'QA may not read contract inputs/outputs (§13)',
    });
  });

  test('QA Read of a path NOT in the deny list allows', () => {
    const ctx = qaCtx(['spec/input.md']);
    const result = decidePreToolUse(ctx, {
      tool_name: 'Read',
      tool_input: { file_path: `${QA_WORKTREE}/src/a.ts` },
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  test('denies before the size gate — a small denied file is still denied with the §13 reason, not silently allowed', () => {
    const ctx = qaCtx(['spec/input.md']);
    // Small enough to sail through the size gate on its own (well under the default limit).
    const result = decidePreToolUse(
      { ...ctx, fileSize: () => 10 },
      { tool_name: 'Read', tool_input: { file_path: `${QA_WORKTREE}/spec/input.md` } },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('QA may not read contract inputs/outputs (§13)');
  });

  test('also denies Grep/Glob/Edit/Write/MultiEdit/NotebookEdit on a denied path, relative or absolute', () => {
    const ctx = qaCtx(['spec/**']);
    for (const call of [
      { tool_name: 'Grep', tool_input: { path: 'spec/input.md' } },
      { tool_name: 'Glob', tool_input: { path: `${QA_WORKTREE}/spec` } },
      { tool_name: 'Edit', tool_input: { file_path: 'spec/input.md' } },
      { tool_name: 'Write', tool_input: { file_path: 'spec/input.md' } },
      { tool_name: 'MultiEdit', tool_input: { file_path: 'spec/input.md' } },
      { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'spec/notes.ipynb' } },
    ]) {
      const result = decidePreToolUse(ctx, call);
      expect(result.decision).toBe('deny');
    }
  });

  test('an engineer with the same worktree/path is unaffected — the seam is per-role data, not a global rule', () => {
    const ctx = baseCtx({
      role: 'engineer',
      worktreePath: QA_WORKTREE,
      denyReadPaths: undefined,
    });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Read',
      tool_input: { file_path: `${QA_WORKTREE}/spec/input.md` },
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  test('QA Bash "cat" of a denied path denies with the §13 reason', () => {
    const ctx = qaCtx(['spec/input.md']);
    const result = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'cat spec/input.md' },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('QA may not read contract inputs/outputs (§13)');
  });

  test('QA Bash "grep -n foo spec/input.md" (pattern first) denies on the path argument, not the pattern', () => {
    const ctx = qaCtx(['spec/input.md']);
    const result = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'grep -n foo spec/input.md' },
    });
    expect(result.decision).toBe('deny');
  });

  test('QA Bash "head spec/input.md" denies, "cat src/a.ts" allows', () => {
    const ctx = qaCtx(['spec/input.md']);
    const denied = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'head spec/input.md' },
    });
    expect(denied.decision).toBe('deny');

    const allowed = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'cat src/a.ts' },
    });
    expect(allowed).toEqual({ decision: 'allow' });
  });
});
