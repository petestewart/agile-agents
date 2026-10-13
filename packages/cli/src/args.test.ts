import { describe, expect, test } from 'bun:test';
import {
  optionalList,
  optionalString,
  parseArgs,
  parseKnownArgs,
  refuseExtraWords,
  requireOption,
  requirePositional,
} from './args';

describe('parseArgs', () => {
  test('splits positionals from --flag value pairs', () => {
    const result = parseArgs(['H-12', '--by', 'human', '--json']);
    expect(result.positionals).toEqual(['H-12']);
    expect(result.options.by).toBe('human');
    expect(result.options.json).toBe(true);
  });

  test('a flag followed by another flag has no value', () => {
    const result = parseArgs(['--follow', '--ticket', 'TKT-0001']);
    expect(result.options.follow).toBe(true);
    expect(result.options.ticket).toBe('TKT-0001');
  });

  test('empty argv yields empty positionals and options', () => {
    const result = parseArgs([]);
    expect(result.positionals).toEqual([]);
    expect(result.options).toEqual({});
  });

  test('T523: -- ends the options; every word after it is positional, as typed', () => {
    const result = parseArgs(['--name', 'x', '--', '--weird', 'dir', '--json']);
    expect(result.options).toEqual({ name: 'x' });
    expect(result.positionals).toEqual(['--weird', 'dir', '--json']);
  });
});

/** T523 (CLI audit C3): a free-text verb keeps its sentence. */
describe('parseKnownArgs', () => {
  const ANSWER = { verb: 'agile answer', values: ['by'] };

  test('keeps every word in order, and reads the verb\u2019s own options wherever they are', () => {
    const result = parseKnownArgs(['Q-1', 'use', 'the', '--by', 'pete', 'second', 'one'], ANSWER);
    expect(result.positionals).toEqual(['Q-1', 'use', 'the', 'second', 'one']);
    expect(result.options).toEqual({ by: 'pete' });
  });

  test('refuses an unknown --word by name and says how to keep it, instead of eating a word', () => {
    // parseArgs made `--no-verify` an option that ate "then": "use push" was sent.
    const lossy = parseArgs(['Q-1', 'use', '--no-verify', 'then', 'push']);
    expect(lossy.positionals.slice(1).join(' ')).toBe('use push');

    expect(() => parseKnownArgs(['Q-1', 'use', '--no-verify', 'then', 'push'], ANSWER)).toThrow(
      'agile answer: unknown option --no-verify (its options: --by). If it is part of the text, quote the text or put -- before it',
    );
  });

  test('-- keeps the rest verbatim, option-shaped words included', () => {
    const result = parseKnownArgs(['Q-1', '--', 'use', '--no-verify', '--by', 'x'], ANSWER);
    expect(result.positionals).toEqual(['Q-1', 'use', '--no-verify', '--by', 'x']);
    expect(result.options).toEqual({});
  });

  test('a word with a single dash is text: a line may start with "-"', () => {
    const result = parseKnownArgs(['N', '-', 'first,', 'check', '-1', 'and', '-h'], {
      verb: 'agile node say',
    });
    expect(result.positionals).toEqual(['N', '-', 'first,', 'check', '-1', 'and', '-h']);
  });

  test('an option of its own with no value is an error, not `true`', () => {
    expect(() => parseKnownArgs(['Q-1', 'yes', '--by'], ANSWER)).toThrow(
      'agile answer: --by needs a value',
    );
    expect(() => parseKnownArgs(['Q-1', '--by', '--', 'x'], ANSWER)).toThrow('--by needs a value');
  });

  test('a verb with no options of its own names none, and a custom hint replaces the -- advice', () => {
    expect(() => parseKnownArgs(['N', 'retry', '--force'], { verb: 'agile node say' })).toThrow(
      'agile node say: unknown option --force. If it is part of the text',
    );
    expect(() =>
      parseKnownArgs(['--text', 'use', '--force'], {
        verb: 'agile question raise',
        values: ['text'],
        hint: 'quote the whole text',
      }),
    ).toThrow(
      'agile question raise: unknown option --force (its options: --text). quote the whole text',
    );
  });
});

describe('refuseExtraWords (T523)', () => {
  test('words no option took are refused, never dropped', () => {
    const args = parseArgs(['--text', 'which', 'branch', 'now']);
    expect(args.options.text).toBe('which');
    expect(() =>
      refuseExtraWords(args, 0, 'agile question raise', '--text "which branch?"'),
    ).toThrow(
      'agile question raise: "branch now" belongs to no option; quote a value with spaces (--text "which branch?")',
    );
    expect(() =>
      refuseExtraWords(parseArgs(['Q-1', '--answer', 'yes']), 1, 'v', 'e'),
    ).not.toThrow();
  });
});

describe('requireOption', () => {
  test('returns the string value when present', () => {
    expect(requireOption({ from: 'em' }, 'from')).toBe('em');
  });

  test('throws when missing', () => {
    expect(() => requireOption({}, 'from')).toThrow(/--from is required/);
  });

  test('throws when the flag has no value (boolean true)', () => {
    expect(() => requireOption({ from: true }, 'from')).toThrow(/--from is required/);
  });
});

describe('optionalString', () => {
  test('returns undefined when absent or boolean', () => {
    expect(optionalString({}, 'ticket')).toBeUndefined();
    expect(optionalString({ ticket: true }, 'ticket')).toBeUndefined();
  });

  test('returns the string when present', () => {
    expect(optionalString({ ticket: 'TKT-0001' }, 'ticket')).toBe('TKT-0001');
  });
});

describe('requirePositional', () => {
  test('returns the positional at the given index', () => {
    const args = parseArgs(['H-12']);
    expect(requirePositional(args, 0, 'hil-id')).toBe('H-12');
  });

  test('throws a usage-shaped error when absent', () => {
    const args = parseArgs([]);
    expect(() => requirePositional(args, 0, 'hil-id')).toThrow(/<hil-id> is required/);
  });
});

describe('repeated options (T200)', () => {
  test('options keeps last-wins; optionalList accumulates and splits commas', () => {
    const args = parseArgs(['--repo', 'a', '--repo', 'b,c', '--name', 'x']);
    expect(args.options.repo).toBe('b,c');
    expect(optionalList(args, 'repo')).toEqual(['a', 'b', 'c']);
    expect(optionalList(args, 'none')).toBeUndefined();
    expect(optionalList({ positionals: [], options: { repo: 'x,y' } }, 'repo')).toEqual(['x', 'y']);
  });
});
