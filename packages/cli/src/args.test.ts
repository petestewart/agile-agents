import { describe, expect, test } from 'bun:test';
import { optionalList, optionalString, parseArgs, requireOption, requirePositional } from './args';

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
