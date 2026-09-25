/**
 * T327: `agile project set` tracker flags — parsed and merged offline; the
 * round trip through the daemon is in `project.e2e.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../args';
import { mergeTracker, parseTrackerFlags } from './project';

const parse = (argv: string[]) => parseTrackerFlags(parseArgs(['P-x', ...argv]));

describe('parseTrackerFlags', () => {
  test('absent flags parse to undefined', () => {
    expect(parse(['--name', 'Shop'])).toBeUndefined();
  });

  test('system, push status and a status map with spaces', () => {
    expect(
      parse([
        '--tracker',
        'jira',
        '--push-status',
        'on',
        '--status-map',
        'in_progress=In Progress,in_review=Code Review',
        '--status-map',
        'done=Done',
      ]),
    ).toEqual({
      system: 'jira',
      push_status: true,
      status_map: { in_progress: 'In Progress', in_review: 'Code Review', done: 'Done' },
    });
    expect(parse(['--status-map', 'in_review='])).toEqual({ status_map: { in_review: null } });
    expect(parse(['--tracker', 'none'])).toEqual({ system: 'none' });
  });

  test('bad input is refused', () => {
    expect(() => parse(['--tracker', 'github'])).toThrow(/jira, linear or none/);
    expect(() => parse(['--push-status', 'yes'])).toThrow(/on or off/);
    expect(() => parse(['--status-map', 'review=Code Review'])).toThrow(/in_progress=<Name>/);
    expect(() => parse(['--status-map', 'Done'])).toThrow(/in_progress=<Name>/);
    expect(() => parse(['--tracker'])).toThrow(/needs a value/);
    expect(() => parse(['--tracker', 'none', '--push-status', 'on'])).toThrow(/takes no/);
  });
});

describe('mergeTracker', () => {
  const jira = {
    system: 'jira' as const,
    base_url: 'https://acme.atlassian.net',
    push_status: true,
    status_map: { in_progress: 'In Progress', done: 'Done' },
  };

  test('merges into the current block and clears one key', () => {
    expect(mergeTracker(jira, { status_map: { in_review: 'Review', done: null } })).toEqual({
      ...jira,
      status_map: { in_progress: 'In Progress', in_review: 'Review' },
    });
    expect(mergeTracker(jira, { push_status: false })).toEqual({ ...jira, push_status: false });
  });

  test('switching system starts fresh; none removes; no system is refused', () => {
    expect(mergeTracker(jira, { system: 'linear' })).toEqual({
      system: 'linear',
      push_status: false,
    });
    expect(mergeTracker(jira, { system: 'none' })).toBeNull();
    expect(() => mergeTracker(undefined, { push_status: true })).toThrow(/no tracker/);
  });
});
