import { describe, expect, test } from 'bun:test';
import { approxTokenCount, render } from './template';

describe('render — interpolation', () => {
  test('substitutes a top-level field', () => {
    expect(render('hello {{name}}', { name: 'world' })).toBe('hello world');
  });

  test('substitutes a dotted-path field', () => {
    expect(render('{{ticket.id}}', { ticket: { id: 'TKT-0001' } })).toBe('TKT-0001');
  });

  test('throws when a field is missing (undefined)', () => {
    expect(() => render('{{missing}}', {})).toThrow(/missing required field "missing"/);
  });

  test('throws when a field is null', () => {
    expect(() => render('{{x}}', { x: null })).toThrow(/missing required field "x"/);
  });

  test('renders falsy-but-present values (0, empty string, false)', () => {
    expect(render('{{n}}', { n: 0 })).toBe('0');
    expect(render('{{s}}', { s: '' })).toBe('');
    expect(render('{{b}}', { b: false })).toBe('false');
  });
});

describe('render — #each', () => {
  test('repeats the block once per item, scoping lookups to the item', () => {
    const out = render('{{#each items}}<{{id}}>{{/each}}', {
      items: [{ id: 'a' }, { id: 'b' }],
    });
    expect(out).toBe('<a><b>');
  });

  test('supports {{this}} for scalar lists', () => {
    expect(render('{{#each xs}}{{this}},{{/each}}', { xs: [1, 2, 3] })).toBe('1,2,3,');
  });

  test('renders nothing for an empty array (no throw)', () => {
    expect(render('[{{#each items}}x{{/each}}]', { items: [] })).toBe('[]');
  });

  test('throws when the list field is missing', () => {
    expect(() => render('{{#each items}}x{{/each}}', {})).toThrow(/missing required list "items"/);
  });

  test('throws when the field is not an array', () => {
    expect(() => render('{{#each items}}x{{/each}}', { items: 'nope' })).toThrow(
      /must be an array/,
    );
  });
});

describe('render — #if', () => {
  test('renders the block when the field is truthy', () => {
    expect(render('{{#if x}}yes{{/if}}', { x: true })).toBe('yes');
  });

  test('omits the block when the field is falsy', () => {
    expect(render('{{#if x}}yes{{/if}}', { x: false })).toBe('');
  });

  test('omits the block when the field is missing (does not throw)', () => {
    expect(render('{{#if x}}yes{{/if}}', {})).toBe('');
  });

  test('treats an empty array as falsy', () => {
    expect(render('{{#if xs}}yes{{/if}}', { xs: [] })).toBe('');
  });
});

describe('render — nesting and errors', () => {
  test('supports #if nested inside #each', () => {
    const out = render('{{#each items}}[{{#if flag}}Y{{/if}}]{{/each}}', {
      items: [{ flag: true }, { flag: false }],
    });
    expect(out).toBe('[Y][]');
  });

  test('throws on an unclosed block', () => {
    expect(() => render('{{#each items}}x', { items: [] })).toThrow(/unclosed/);
  });

  test('throws on a mismatched close', () => {
    expect(() => render('{{#each items}}x{{/if}}', { items: [] })).toThrow(/unexpected/);
  });
});

describe('approxTokenCount', () => {
  test('approximates chars/4', () => {
    expect(approxTokenCount('a'.repeat(400))).toBe(100);
  });
});
