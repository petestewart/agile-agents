/**
 * Vendor-conformance fixtures for the PreToolUse gate, asserted against this
 * repo's own recorded spike captures instead of a live `claude login`'d
 * session.
 *
 * Replaces two `AGILE_LIVE=1` tests that spawned real Claude sessions to
 * re-derive facts already measured and committed:
 *   - `packages/acp-client/src/live.test.ts` ("live: Claude default-mode
 *     permission scenario") re-ran design/spike-findings.md §A against
 *     `spike/spike-out/claude-default-perm.json`.
 *   - `packages/daemon/src/hook/live.test.ts` ("live: Claude hook gate
 *     end-to-end") re-ran §B against
 *     `spike/spike-out/claude-default-perm-hooks.json`.
 * CLAUDE.md: "design/spike-findings.md — measured per-vendor behaviour ...
 * Don't re-derive these; cite them." These tests cite them.
 *
 * The two captures are the same scenario run twice — once with no hook, once
 * with the PreToolUse hook installed — so their difference isolates exactly
 * what the gate changes, with no vendor login, no network and no model
 * nondeterminism. The gate's own behaviour is asserted through the real
 * `decidePreToolUse`, so a regression in the decision function fails here.
 *
 * What these captures do NOT support: every row's `rawInput` is `{}` (the
 * ACP wire carries no command text for these calls), so nothing here asserts
 * per-command policy. Command/edit policy is covered offline by
 * `decide.test.ts` and `service.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decidePreToolUse } from './decide';
import { DEFAULT_MAX_READ_BYTES, type HookDecisionContext } from './types';

const SPIKE_OUT = join(import.meta.dir, '..', '..', '..', '..', 'spike', 'spike-out');

/** One `result.matrix` row of a spike capture. */
interface MatrixRow {
  tool: string;
  kind: string;
  title: string;
  permissionRaised: boolean;
  ourAnswer: string;
  finalStatus: string;
}

interface SpikeCapture {
  vendor: string;
  mode: string;
  result: {
    matrix: MatrixRow[];
    finalText: string;
    hookFired?: number;
    hookReasonSeenByModel?: boolean;
  };
}

function loadCapture(name: string): SpikeCapture {
  return JSON.parse(readFileSync(join(SPIKE_OUT, `${name}.json`), 'utf8')) as SpikeCapture;
}

const noHook = loadCapture('claude-default-perm');
const withHook = loadCapture('claude-default-perm-hooks');

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

describe('spike capture provenance', () => {
  test('both captures are the same Claude default-mode scenario, one with the hook installed', () => {
    for (const capture of [noHook, withHook]) {
      expect(capture.vendor).toBe('claude');
      expect(capture.mode).toBe('default');
    }
    // Same scenario, same number of tool calls — the only intended
    // difference is the hook.
    expect(withHook.result.matrix).toHaveLength(noHook.result.matrix.length);
    expect(noHook.result.hookFired).toBeUndefined();
    expect(withHook.result.hookFired).toBeGreaterThan(0);
  });
});

describe('the PreToolUse gate changes exactly one recorded outcome', () => {
  /**
   * Rows that differ between the two runs. Recorded reality: only the second
   * `Read` (the oversized one) flips `completed` -> `failed`. Everything else
   * — every exec, every edit, the small read — is untouched by the hook.
   */
  const differing = noHook.result.matrix
    .map((row, i) => ({ i, before: row, after: withHook.result.matrix[i] as MatrixRow }))
    .filter(({ before, after }) => before.finalStatus !== after.finalStatus);

  test('exactly one row differs, and it is a read that the hook failed', () => {
    expect(differing).toHaveLength(1);
    const [only] = differing;
    expect(only?.before.tool).toBe('Read');
    expect(only?.before.kind).toBe('read');
    expect(only?.before.finalStatus).toBe('completed');
    expect(only?.after.finalStatus).toBe('failed');
  });

  test('the hook never raised an ACP permission request — gating happened at tier 1, not tier 2', () => {
    // The blocked read raised no permission request in either run: the hook
    // denied it before ACP was ever consulted.
    const [only] = differing;
    expect(only?.before.permissionRaised).toBe(false);
    expect(only?.after.permissionRaised).toBe(false);
    // And the whole permission-request table is otherwise identical, so
    // installing the hook did not change what the vendor itself gates.
    const perms = (c: SpikeCapture) =>
      c.result.matrix.map((r) => `${r.tool}:${r.kind}:${r.permissionRaised}`);
    expect(perms(withHook)).toEqual(perms(noHook));
  });
});

describe('decidePreToolUse reproduces the recorded gate', () => {
  test('an oversized raw Read is denied and the reason points at read_summary', () => {
    const decision = decidePreToolUse(baseCtx({ fileSize: () => DEFAULT_MAX_READ_BYTES + 1 }), {
      tool_name: 'Read',
      tool_input: { file_path: '/repo/.worktrees/TKT-0001/big.txt' },
    });
    expect(decision.decision).toBe('deny');
    // The capture's own denial names `read_summary(path, question)`; ours
    // must too, or the model is told to do something it cannot do.
    expect(decision.reason).toContain('read_summary');
  });

  test("the recorded run shows that reason reaching the model's own output", () => {
    expect(withHook.result.hookReasonSeenByModel).toBe(true);
    expect(withHook.result.finalText).toContain('read_summary');
    // The no-hook run is the control: same scenario, no such text.
    expect(noHook.result.finalText).not.toContain('read_summary');
  });

  test('a read under the limit is allowed — the gate is a size gate, not a read ban', () => {
    const decision = decidePreToolUse(baseCtx({ fileSize: () => DEFAULT_MAX_READ_BYTES - 1 }), {
      tool_name: 'Read',
      tool_input: { file_path: '/repo/.worktrees/TKT-0001/small.txt' },
    });
    expect(decision.decision).toBe('allow');
  });

  test('every read the captures recorded as ungated by the vendor is left to tier 1 alone', () => {
    // Recorded fact (§A): Claude raises no ACP permission request for any
    // read, in either run. So tier 1 is the only gate reads ever get, which
    // is why the size check has to live here.
    const reads = noHook.result.matrix.filter((r) => r.kind === 'read');
    expect(reads.length).toBeGreaterThan(0);
    for (const row of reads) {
      expect(row.permissionRaised).toBe(false);
    }
  });
});
