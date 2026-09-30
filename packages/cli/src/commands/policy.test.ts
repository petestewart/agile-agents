import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { builtinModelPolicy, ulid } from '@agile-agents/shared';
import { parseArgs } from '../args';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { parsePolicyValue, policyField, policyValueText, runPolicyStepUp } from './policy';

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
