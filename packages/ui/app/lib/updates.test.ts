import { describe, expect, test } from 'bun:test';
import type { HarnessStatus } from '@agile-agents/shared';
import { methodText, offersUpdate, updateState } from './updates';

const base: HarnessStatus = {
  id: 'claude',
  vendor: 'claude',
  label: 'Claude Code',
  mode: 'alert',
  found: true,
  behind: false,
  can_update: true,
  checked_at: '2026-09-29T10:00:00.000Z',
};

describe('T481 a CLI row in Settings → Agents → Updates', () => {
  test('its state in words', () => {
    expect(updateState({ ...base, mode: 'off' }).text).toBe('Off');
    expect(updateState({ ...base, checked_at: undefined }).text).toBe('Not checked yet');
    expect(updateState({ ...base, found: false }).text).toBe('Not installed');
    expect(updateState({ ...base, updating: true }).text).toBe('Updating…');
    expect(
      updateState({ ...base, version: '2.2.9', latest: '2.3.1', behind: true, method: 'npm' }),
    ).toEqual({ text: 'Update available', tone: 'blue' });
    expect(updateState({ ...base, version: '2.3.1', latest: '2.3.1' }).text).toBe('Up to date');
    const manual = 'Can’t check Grok CLI automatically; update it the way you installed it (/x).';
    expect(updateState({ ...base, can_update: false, method: 'unknown', manual })).toEqual({
      text: 'Can’t check',
      tone: 'gray',
      hint: manual,
    });
    expect(
      updateState({ ...base, version: '2.2.9', error: 'couldn’t read the newest version (x)' }),
    ).toMatchObject({ text: 'Couldn’t check', hint: 'Couldn’t read the newest version (x)' });
    expect(updateState({ ...base, method: 'native', command: 'claude update' })).toMatchObject({
      text: 'Newest unknown',
      hint: 'Its own installer finds the newest version when you press Update (claude update).',
    });
  });

  test('Update shows for a CLI behind, or one whose installer finds the newest itself', () => {
    expect(offersUpdate({ ...base, version: '2.2.9', latest: '2.3.1', behind: true })).toBe(true);
    expect(offersUpdate({ ...base, version: '2.3.1', latest: '2.3.1' })).toBe(false);
    expect(offersUpdate({ ...base, method: 'native' })).toBe(true);
    expect(offersUpdate({ ...base, can_update: false })).toBe(false);
    expect(offersUpdate({ ...base, found: false })).toBe(false);
    expect(offersUpdate({ ...base, behind: true, mode: 'off' })).toBe(false);
  });

  test('how it was installed', () => {
    expect(methodText({ ...base, method: 'brew', package: 'gemini-cli' })).toBe(
      'Homebrew: gemini-cli',
    );
    expect(methodText({ ...base, method: 'npm', package: '@openai/codex' })).toBe(
      'npm (global): @openai/codex',
    );
    expect(methodText({ ...base, method: 'native' })).toBe('its own installer');
    expect(methodText(base)).toBe('—');
  });
});
