/** T461: the slash commands a vendor advertises, and the command a composer line starts with. */

import { describe, expect, test } from 'bun:test';
import { slashCommandOf } from '@agile-agents/shared';
import { advertisedCommands } from './session';

describe('T461: the commands a vendor advertises', () => {
  test('parsed from ACP, a leading slash dropped, duplicates and bad names left out', () => {
    expect(
      advertisedCommands({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'compact', description: 'Keep a summary' },
          { name: '/review', description: 'Review a PR', input: { hint: 'PR number' } },
          { name: 'compact', description: 'again' },
          { name: 'has space', description: 'x' },
          { name: 42 },
          'not an object',
          { name: 'project:deploy' },
        ],
      }),
    ).toEqual([
      { name: 'compact', description: 'Keep a summary' },
      { name: 'review', description: 'Review a PR', hint: 'PR number' },
      { name: 'project:deploy', description: '' },
    ]);
    expect(advertisedCommands({ availableCommands: 'nope' })).toEqual([]);
    expect(advertisedCommands(null)).toEqual([]);
  });

  test('the command a line starts with', () => {
    expect(slashCommandOf('/compact')).toBe('compact');
    expect(slashCommandOf('  /review 12')).toBe('review');
    expect(slashCommandOf('/project:deploy now')).toBe('project:deploy');
    expect(slashCommandOf('please /compact')).toBeUndefined();
    expect(slashCommandOf('/ nothing')).toBeUndefined();
    expect(slashCommandOf('/usr/bin/env is a path')).toBeUndefined();
  });
});
