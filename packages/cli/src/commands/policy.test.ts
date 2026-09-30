import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { builtinModelPolicy, ulid } from '@agile-agents/shared';
import { parseArgs } from '../args';
import { type TestDaemon, startTestDaemon } from '../test-support';
import {
  parsePolicyValue,
  policyField,
  policyRole,
  policyValueText,
  runPolicySet,
  runPolicyStepUp,
  withRoleOrder,
} from './policy';

describe('agile policy (T482)', () => {
  test('field names take - or _', () => {
    expect(policyField('effort-ceiling')).toBe('effort_ceiling');
    expect(policyField('pinned_rules')).toBe('pinned_rules');
    expect(() => policyField('allowed')).toThrow(/unknown field/);
  });

  test('values parse per field; inherit clears', () => {
    expect(parsePolicyValue('mode', 'choose')).toBe('choose');
    expect(parsePolicyValue('mode', 'inherit')).toBeNull();
    expect(() => parsePolicyValue('mode', 'always')).toThrow(/not one of/);
    expect(parsePolicyValue('escalation', 'strongest-first')).toBe('strongest_first');
    expect(parsePolicyValue('quality', '70')).toBe(70);
    expect(() => parsePolicyValue('quality', '120')).toThrow(/0 \(speed/);
    expect(parsePolicyValue('presets', 'claude/claude-sonnet-5-5, codex/gpt-5.5')).toEqual([
      { vendor: 'claude', model: 'claude-sonnet-5-5' },
      { vendor: 'codex', model: 'gpt-5.5' },
    ]);
    expect(parsePolicyValue('presets', 'any')).toEqual([]);
    expect(() => parsePolicyValue('presets', 'sonnet')).toThrow(/vendor\/model/);
    expect(parsePolicyValue('weights', 'clarity=2,stakes=3')).toEqual({ clarity: 2, stakes: 3 });
    expect(parsePolicyValue('guidance', 'Prefer Codex for Rust.')).toBe('Prefer Codex for Rust.');
    expect(parsePolicyValue('pinned_rules', '[]')).toEqual([]);
  });

  test('values in words', () => {
    const p = builtinModelPolicy();
    expect(policyValueText('presets', p)).toBe('any installed model');
    expect(policyValueText('mode', p)).toBe('choose');
    expect(policyValueText('guidance', p)).toBe('(none)');
  });
});

describe('agile policy step-up (T484)', () => {
  let daemon: TestDaemon;

  beforeEach(async () => {
    daemon = await startTestDaemon('agile-cli-step-up-');
  });

  afterEach(async () => {
    await daemon.cleanup();
  });

  async function capture(run: () => Promise<number>): Promise<{ code: number; out: string }> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      const code = await run();
      return { code, out: lines.join('\n') };
    } finally {
      console.log = original;
    }
  }

  test('the node’s next start runs one rung up; refused before its agent ran', async () => {
    const node = await daemon.streamService.create('human', { title: 'Parser', goal: 'g' });
    await expect(
      runPolicyStepUp(daemon.socketPath, parseArgs(['--node', node.id]), false),
    ).rejects.toThrow(/hasn’t started yet/);
    await daemon.store.updateStream('daemon', node.id, (s) => ({
      ...s,
      sessions: [
        {
          id: ulid(),
          vendor: 'claude',
          model: 'claude-sonnet-5-5',
          effort: 'medium',
          role: 'worker',
          status: 'stopped',
        },
      ],
    }));
    const { code, out } = await capture(() =>
      runPolicyStepUp(daemon.socketPath, parseArgs(['--node', node.id]), false),
    );
    expect(code).toBe(0);
    expect(out).toBe(
      'agile policy step-up: Parser runs Claude Sonnet 5.5 · high at its next start',
    );
    expect(daemon.streamService.get(node.id).escalation?.pending).toMatchObject({
      trigger: 'operator',
      by: 'human',
    });
    await expect(runPolicyStepUp(daemon.socketPath, parseArgs([]), false)).rejects.toThrow(
      /--node <id> is required/,
    );
  });
});

describe('agile policy set vendor_order (T490, D59)', () => {
  let daemon: TestDaemon;

  beforeEach(async () => {
    daemon = await startTestDaemon('agile-cli-vendor-order-');
  });

  afterEach(async () => {
    await daemon.cleanup();
  });

  test('the fields parse; a role is named after a dot', () => {
    expect(policyField('vendor-order')).toBe('vendor_order');
    expect(policyField('vendor_order_by_role.reviewer')).toBe('vendor_order_by_role');
    expect(policyRole('vendor_order_by_role.reviewer')).toBe('reviewer');
    expect(policyRole('vendor_order')).toBeUndefined();
    expect(() => policyRole('vendor_order_by_role.tester')).toThrow(/not a role/);
    expect(() => policyRole('quality.reviewer')).toThrow(/only vendor_order_by_role/);
    expect(parsePolicyValue('vendor_order', 'claude, Codex')).toEqual(['claude', 'codex']);
    expect(parsePolicyValue('vendor_order', 'none')).toEqual([]);
    expect(parsePolicyValue('vendor_order', 'inherit')).toBeNull();
    expect(() => parsePolicyValue('vendor_order', 'claude,openai')).toThrow(/not a vendor/);
    expect(() => parsePolicyValue('vendor_order', 'claude,claude')).toThrow(/once/);
    expect(() => parsePolicyValue('vendor_order_by_role', 'codex')).toThrow(/name a role/);
    expect(withRoleOrder({ worker: ['claude'] }, 'reviewer', 'codex,claude')).toEqual({
      worker: ['claude'],
      reviewer: ['codex', 'claude'],
    });
    expect(withRoleOrder({ reviewer: ['codex'] }, 'reviewer', 'same')).toBeNull();
    const p = {
      ...builtinModelPolicy(),
      vendor_order: ['claude' as const, 'codex' as const],
      vendor_order_by_role: { reviewer: ['codex' as const, 'claude' as const] },
    };
    expect(policyValueText('vendor_order', p)).toBe('Claude, then Codex');
    expect(policyValueText('vendor_order_by_role', p)).toBe('reviewer: Codex, then Claude');
    expect(policyValueText('vendor_order_by_role', builtinModelPolicy())).toBe(
      'same as vendor_order for every role',
    );
  });

  test('over the socket: the order, then one role’s own, merged into the layer', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await runPolicySet(daemon.socketPath, parseArgs(['vendor_order', 'claude,codex']), false);
      await runPolicySet(
        daemon.socketPath,
        parseArgs(['vendor_order_by_role.reviewer', 'codex,claude']),
        false,
      );
      await runPolicySet(
        daemon.socketPath,
        parseArgs(['vendor_order_by_role.worker', 'claude']),
        false,
      );
    } finally {
      console.log = original;
    }
    expect(daemon.store.getHomeConfig().model_policy).toEqual({
      vendor_order: ['claude', 'codex'],
      vendor_order_by_role: { reviewer: ['codex', 'claude'], worker: ['claude'] },
    });
    expect(lines.join('\n')).toContain('reviewer: Codex, then Claude');
    // `same` takes one role out; the last one out inherits the field again.
    await runPolicySet(daemon.socketPath, parseArgs(['vendor_order_by_role.worker', 'same']), true);
    await runPolicySet(
      daemon.socketPath,
      parseArgs(['vendor_order_by_role.reviewer', 'same']),
      true,
    );
    expect(daemon.store.getHomeConfig().model_policy).toEqual({
      vendor_order: ['claude', 'codex'],
    });
    // A node's own, beside its project's.
    const node = await daemon.streamService.create('human', { title: 'Parser', goal: 'g' });
    await runPolicySet(
      daemon.socketPath,
      parseArgs(['vendor_order_by_role.reviewer', 'codex', '--node', node.id]),
      true,
    );
    expect(daemon.streamService.get(node.id).human.model_policy).toEqual({
      vendor_order_by_role: { reviewer: ['codex'] },
    });
  });
});
