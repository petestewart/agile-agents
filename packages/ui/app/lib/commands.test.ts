/** T461: the composer's `/` menu, its hint, and the commands it holds. */

import { describe, expect, test } from 'bun:test';
import { type SlashContext, commandHint, commandMenu, heldCommand } from './commands';

const COMMANDS = [
  { name: 'compact', description: 'Clear the conversation but keep a summary' },
  { name: 'review', description: 'Review a pull request', hint: 'PR number' },
  { name: 'init', description: 'Write a CLAUDE.md for this repo' },
];
const live: SlashContext = { running: true, vendor: 'claude', commands: COMMANDS };

describe('the / menu', () => {
  test('opens on a command being typed, names first, then descriptions', () => {
    expect(commandMenu('/', COMMANDS)?.map((c) => c.name)).toEqual(['compact', 'review', 'init']);
    expect(commandMenu('/rev', COMMANDS)?.map((c) => c.name)).toEqual(['review']);
    // A name match comes before a description match ("repo" is in init's).
    expect(commandMenu('/re', COMMANDS)?.map((c) => c.name)).toEqual(['review', 'init']);
    // "conversation" is in compact's description.
    expect(commandMenu('/conv', COMMANDS)?.map((c) => c.name)).toEqual(['compact']);
    expect(commandMenu('/zzz', COMMANDS)).toEqual([]);
  });
  test('closed once the command has an argument, and for any other line', () => {
    expect(commandMenu('/review ', COMMANDS)).toBeUndefined();
    expect(commandMenu('hello', COMMANDS)).toBeUndefined();
    expect(commandMenu('', COMMANDS)).toBeUndefined();
  });
});

describe('what a / line will do', () => {
  test('an advertised command runs as typed', () => {
    expect(commandHint('/compact', live)).toBe('Runs /compact on Claude.');
    expect(heldCommand('/review 12', live)).toBeUndefined();
  });
  test('/login is held with how to log in, unless the vendor offers it', () => {
    expect(heldCommand('/login', live)).toBe(
      '/login can’t run here: the cockpit runs Claude without a terminal. Log in from a terminal instead (run `claude` and type /login), then send a message.',
    );
    expect(heldCommand('/logout', { ...live, vendor: 'codex' })).toContain('run `codex login`');
    expect(commandHint('/login', live)).toBeUndefined();
    const offers = { ...live, commands: [...COMMANDS, { name: 'login', description: 'Log in' }] };
    expect(heldCommand('/login', offers)).toBeUndefined();
  });
  test('/model points at the model chip', () => {
    expect(heldCommand('/model opus', live)).toContain('model chip');
  });
  test('an unknown command goes as a message, and the hint says so', () => {
    expect(heldCommand('/frobnicate', live)).toBeUndefined();
    expect(commandHint('/frobnicate', live)).toBe(
      'Claude doesn’t offer /frobnicate here, so this goes as a message.',
    );
    expect(commandHint('/compact', { running: false, commands: [] })).toBe(
      'Commands work once the agent is running. This goes to Claude as a message.',
    );
  });
  test('any other line has no command hint', () => {
    expect(commandHint('please /compact', live)).toBeUndefined();
    expect(commandHint('', live)).toBeUndefined();
    expect(heldCommand('log in please', live)).toBeUndefined();
  });
});
