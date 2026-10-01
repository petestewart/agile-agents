import { describe, expect, test } from 'bun:test';
import type { VendorCheckResult, VendorCheckRow } from '@agile-agents/shared';
import { usageShort, vendorRowView } from './vendor-checks';

const NOW = Date.parse('2026-09-30T10:05:00.000Z');

const last: VendorCheckResult = {
  vendor: 'codex',
  label: 'Codex',
  session: '01K6AAAAAAAAAAAAAAAAAAAAAA',
  cli_version: '0.50.0',
  started_at: '2026-09-30T10:00:00.000Z',
  finished_at: '2026-09-30T10:00:00.000Z',
  reason: 'manual',
  by: 'human',
  logged_in: true,
  opened: true,
  model: { outcome: 'honoured', from: 'gpt-6-astra', to: 'gpt-5.5', after: 'gpt-5.5' },
  effort: { outcome: 'kept', from: 'medium', to: 'low', after: 'medium' },
  prompt: { outcome: 'finished' },
  usage: {
    update_fields: ['used', 'size'],
    reply_keys: ['stopReason', 'usage'],
    reply_usage_fields: ['inputTokens', 'outputTokens'],
    turn_tokens: true,
    context: true,
  },
  rate_limits: [{ where: 'turn_end', name: 'rateLimits.primary.usedPercent', value: '12' }],
  resume: { outcome: 'ok', detail: 'Codex loaded its session again' },
  errors: [],
};

const row: VendorCheckRow = {
  vendor: 'codex',
  label: 'Codex',
  installed: true,
  cli_version: '0.50.0',
  running: false,
  queued: false,
};

describe('T489 a vendor row in Settings → Agents → Vendors', () => {
  test('never checked, not installed, checking, waiting', () => {
    expect(vendorRowView(row, NOW)).toMatchObject({
      version: '0.50.0',
      when: 'Never checked',
      state: { text: 'Not checked yet' },
      model: { mark: '—' },
      canCheck: true,
    });
    expect(vendorRowView({ ...row, installed: false, cli_version: undefined }, NOW)).toMatchObject({
      when: 'Not installed',
      canCheck: false,
    });
    expect(vendorRowView({ ...row, running: true }, NOW)).toMatchObject({
      when: 'Checking…',
      state: { text: 'Checking', tone: 'blue' },
      canCheck: false,
    });
    expect(vendorRowView({ ...row, queued: true, last }, NOW).when).toBe('Waiting');
  });

  test('a result in marks and words', () => {
    const view = vendorRowView({ ...row, last }, NOW);
    expect(view.when).toBe('Checked 5m ago');
    expect(view.state).toEqual({ text: 'Checked', tone: 'green' });
    expect(view.model).toEqual({ mark: '✓', words: 'Model: took gpt-5.5' });
    expect(view.effort).toEqual({
      mark: '✗',
      words: 'Effort: kept its own (medium); didn’t take low',
    });
    expect(view.resume).toEqual({ mark: '✓', words: 'Resume: Codex loaded its session again' });
    expect(view.usage).toBe('inputTokens, outputTokens, used, size');
    expect(view.rateLimits).toEqual(['rateLimits.primary.usedPercent: 12']);
  });

  test('a vendor that keeps its own model: amber, and model choice leaves it out', () => {
    const view = vendorRowView(
      {
        ...row,
        last: { ...last, model: { outcome: 'kept', to: 'gpt-5.5', after: 'gpt-6-astra' } },
      },
      NOW,
    );
    expect(view.state).toEqual({ text: 'Keeps its own model', tone: 'amber' });
    expect(view.model.mark).toBe('✗');
    expect(view.leftOut).toBe('Model choice leaves Codex out: a model picked for it doesn’t take.');
    expect(vendorRowView({ ...row, last }, NOW).leftOut).toBeUndefined();
  });

  test('T494: a vendor that refused the model it was given stays in model choice', () => {
    const view = vendorRowView(
      {
        ...row,
        last: {
          ...last,
          model: { outcome: 'refused', to: 'opus[1m]', detail: 'Internal error' },
          errors: ['Codex refused the model opus[1m]: Internal error'],
        },
      },
      NOW,
    );
    expect(view.state).toEqual({ text: 'Refused the model it was given', tone: 'amber' });
    expect(view.model.mark).toBe('✗');
    expect(view.leftOut).toBeUndefined();
  });

  test('T494: an installed CLI whose bridge is missing can’t start, and says which command', () => {
    const missing = 'Pi can’t start: `pi-acp` is not on the daemon’s PATH.';
    const view = vendorRowView(
      { ...row, installed: false, cli_version: '0.87.1', missing, last: undefined },
      NOW,
    );
    expect(view.when).toBe('Can’t start');
    expect(view.state).toEqual({ text: 'Can’t start', tone: 'amber' });
    expect(view.errors).toEqual([missing]);
    expect(
      vendorRowView({ ...row, installed: false, cli_version: undefined, last: undefined }, NOW)
        .when,
    ).toBe('Not installed');
  });

  test('not logged in: the marks are dashes and the words say how to log in', () => {
    const view = vendorRowView(
      {
        ...row,
        last: {
          ...last,
          logged_in: false,
          opened: false,
          model: { outcome: 'skipped' },
          effort: { outcome: 'skipped' },
          prompt: { outcome: 'skipped' },
          resume: { outcome: 'skipped' },
          errors: [
            'Codex isn’t logged in. Log in from a terminal (run `codex login`), then check it again.',
          ],
        },
      },
      NOW,
    );
    expect(view.state).toEqual({ text: 'Not logged in', tone: 'amber' });
    expect([view.model.mark, view.effort.mark, view.resume.mark, view.usage]).toEqual([
      '—',
      '—',
      '—',
      '—',
    ]);
    expect(view.errors[0]).toContain('run `codex login`');
  });

  test('usage: none when the turn finished with nothing; a long list is cut', () => {
    expect(usageShort({ ...last, usage: undefined })).toBe('none');
    expect(
      usageShort({
        ...last,
        usage: {
          update_fields: ['a', 'b', 'c', 'd'],
          reply_keys: [],
          reply_usage_fields: ['e', 'f', 'g'],
          turn_tokens: true,
          context: false,
        },
      }),
    ).toBe('e, f, g, a, b, c +1');
  });
});
