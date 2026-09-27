import { describe, expect, test } from 'bun:test';
import { resolveVendorFailure } from '@agile-agents/shared';
import { crashHandover, fallbackVendors, retryWontHelp } from './fallback';

describe('T456: the retry rule', () => {
  test('a crash is retried; a login or model refusal, or a command that cannot run, is not', () => {
    expect(retryWontHelp('panic: worker thread died', 1)).toBeUndefined();
    expect(retryWontHelp(undefined, 1)).toBeUndefined();
    expect(retryWontHelp(undefined, 137)).toBeUndefined();
    for (const line of [
      'Invalid API key · Please run /login',
      'Error: not logged in',
      'Authentication failed',
      'request failed with status 401',
      'Missing credentials',
    ]) {
      expect(retryWontHelp(line, 1)).toBe('a login refusal');
    }
    for (const line of [
      'Claude Code 2.1.257 does not support this model; version 2.1.280 or newer is required',
      'Error: unknown model gpt-9',
      'model gemini-9 not found',
    ]) {
      expect(retryWontHelp(line, 1)).toBe('a model refusal');
    }
    expect(retryWontHelp('sh: gemini: not found', 127)).toBe('its command could not run');
  });
});

describe('T456: which vendors a crashed one falls back to', () => {
  const installed = () => true;

  test('the list in order, minus vendors already tried and ones not installed', () => {
    const policy = resolveVendorFailure({
      fallback: ['gemini', 'cursor', 'codex'],
      allow_hookless: true,
    });
    expect(fallbackVendors(policy, 'claude', new Set(['claude', 'gemini']), installed)).toEqual([
      'cursor',
      'codex',
    ]);
    expect(fallbackVendors(policy, 'claude', new Set(), (v) => v !== 'cursor')).toEqual([
      'gemini',
      'codex',
    ]);
  });

  test('a vendor with hooks falls back only to one with hooks, unless hookless is allowed', () => {
    const list = { fallback: ['gemini' as const, 'pi' as const] };
    expect(fallbackVendors(resolveVendorFailure(list), 'claude', new Set(), installed)).toEqual([
      'pi',
    ]);
    expect(
      fallbackVendors(
        resolveVendorFailure({ ...list, allow_hookless: true }),
        'claude',
        new Set(),
        installed,
      ),
    ).toEqual(['gemini', 'pi']);
    // A hookless vendor's floor is not lowered by another hookless one.
    expect(fallbackVendors(resolveVendorFailure(list), 'cursor', new Set(), installed)).toEqual([
      'gemini',
      'pi',
    ]);
  });
});

describe('T456: the new agent is told what happened', () => {
  test('names the last agent and the reason; git status in a worktree, the thread without', () => {
    const text = crashHandover({
      failed: 'Claude Code',
      reason: 'panic',
      retry: false,
      inWorktree: true,
    });
    expect(text).toContain(
      'The previous agent on this node (Claude Code) stopped mid-turn: panic.',
    );
    expect(text).toContain('`git status`');
    expect(text).toContain('Its own session context is gone.');
    const talk = crashHandover({
      failed: 'Gemini CLI',
      reason: 'x',
      retry: true,
      inWorktree: false,
    });
    expect(talk).not.toContain('git status');
    expect(talk).toContain('read the thread');
    expect(talk).toContain('the same agent started again');
  });
});
