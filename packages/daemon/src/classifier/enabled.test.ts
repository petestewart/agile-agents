import { describe, expect, test } from 'bun:test';
import { validateClassifierConfig } from '@agile-agents/shared';
import { classifierEnabled } from './enabled';

const CONFIGURED = validateClassifierConfig({ api_key: 'k' });

describe('classifierEnabled (§6.4, three levels most specific first)', () => {
  test('on when the home is configured and nothing opts out', () => {
    expect(classifierEnabled({ config: CONFIGURED, env: {} })).toBe(true);
  });

  test("the stream's own opt-out wins over an enabled repo and home", () => {
    expect(
      classifierEnabled({
        stream: { classifier: 'off' },
        repo: { classifier: 'on' },
        config: CONFIGURED,
        env: {},
      }),
    ).toBe(false);
  });

  test('the repo default applies when the stream says nothing', () => {
    expect(
      classifierEnabled({ stream: {}, repo: { classifier: 'off' }, config: CONFIGURED, env: {} }),
    ).toBe(false);
    expect(
      classifierEnabled({ stream: {}, repo: { classifier: 'on' }, config: CONFIGURED, env: {} }),
    ).toBe(true);
  });

  test('provider "off" turns the tier off home-wide', () => {
    expect(
      classifierEnabled({
        repo: { classifier: 'on' },
        config: validateClassifierConfig({ provider: 'off', api_key: 'k' }),
        env: {},
      }),
    ).toBe(false);
  });

  test('a missing key is off, and a repo saying "on" cannot conjure one', () => {
    expect(
      classifierEnabled({
        repo: { classifier: 'on' },
        config: validateClassifierConfig({}),
        env: {},
      }),
    ).toBe(false);
  });

  test('the key may come from TYPESAFE_API_KEY', () => {
    expect(
      classifierEnabled({
        config: validateClassifierConfig({}),
        env: { TYPESAFE_API_KEY: 'from-env' },
      }),
    ).toBe(true);
  });
});
