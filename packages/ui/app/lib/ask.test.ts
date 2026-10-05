/** T419 (D42): Ask's targets and words. */

import { describe, expect, test } from 'bun:test';
import {
  DIRECTOR_TARGET,
  askHint,
  askTargets,
  coordinatesIt,
  focusComposerOn,
  hasReplied,
  keepsTitle,
  sendUpTarget,
  takeComposerFocus,
} from './ask';
import type { CockpitProjectRow, CockpitStreamRow } from './feed-types';

function row(id: string, extra: Partial<CockpitStreamRow> = {}): CockpitStreamRow {
  return { id, title: id, role: 'work', agent_status: 'idle', human_status: 'open', ...extra };
}

const project = (id: string, name: string, root: string) =>
  ({ id, name, root }) as unknown as CockpitProjectRow;

describe('askTargets', () => {
  test('the Director first, then each project’s nodes in reading order, grouped', () => {
    const rows = [
      row('root', { role: 'project', project: 'P-1', title: 'Shop' }),
      row('api', { parent: 'root', project: 'P-1' }),
      row('why', { parent: 'api', project: 'P-1', role: 'conversation' }),
      row('blog', { role: 'project', project: 'P-2', title: 'Blog' }),
      row('stray'),
    ];
    const targets = askTargets(rows, [
      project('P-1', 'Shop', 'root'),
      project('P-2', 'Blog', 'blog'),
    ]);
    expect(targets.map((t) => [t.value, t.project, t.depth])).toEqual([
      [DIRECTOR_TARGET, undefined, 0],
      ['root', 'Shop', 0],
      ['api', 'Shop', 1],
      ['why', 'Shop', 2],
      ['blog', 'Blog', 0],
      ['stray', undefined, 0],
    ]);
  });
});

describe('askTargets (T435)', () => {
  test('each target carries its row; merged and closed ones come last in their project, flat', () => {
    const rows = [
      row('root', { role: 'project', project: 'P-1', title: 'Shop' }),
      row('old', { parent: 'root', project: 'P-1', human_status: 'closed' }),
      row('api', { parent: 'root', project: 'P-1' }),
      row('merged', { parent: 'api', project: 'P-1', human_status: 'landed' }),
      row('why', { parent: 'merged', project: 'P-1', role: 'conversation' }),
      row('web', { parent: 'root', project: 'P-1' }),
      row('blog', { role: 'project', project: 'P-2', title: 'Blog' }),
    ];
    const targets = askTargets(rows, [
      project('P-1', 'Shop', 'root'),
      project('P-2', 'Blog', 'blog'),
    ]);
    expect(targets.map((t) => [t.value, t.depth])).toEqual([
      [DIRECTOR_TARGET, 0],
      ['root', 0],
      ['api', 1],
      // Under a merged node: indented by its open ancestors only.
      ['why', 2],
      ['web', 1],
      ['old', 0],
      ['merged', 0],
      ['blog', 0],
    ]);
    expect(targets[0]?.row).toBeUndefined();
    expect(targets.find((t) => t.value === 'merged')?.row?.human_status).toBe('landed');
  });
});

describe('out of a conversation (T435)', () => {
  const rows = [
    row('work'),
    row('merged', { human_status: 'landed' }),
    row('closed', { human_status: 'closed' }),
  ];
  test('Send to goes to an open parent only', () => {
    expect(sendUpTarget({ role: 'conversation', parent: 'work' }, rows)?.id).toBe('work');
    expect(sendUpTarget({ role: 'conversation', parent: 'merged' }, rows)).toBeUndefined();
    expect(sendUpTarget({ role: 'conversation', parent: 'closed' }, rows)).toBeUndefined();
    expect(sendUpTarget({ role: 'conversation', parent: 'gone' }, rows)).toBeUndefined();
    expect(sendUpTarget({ role: 'work', parent: 'work' }, rows)).toBeUndefined();
    expect(sendUpTarget({ role: 'conversation' }, rows)).toBeUndefined();
  });

  test('a work parent is told it will coordinate; others take a child as they are', () => {
    expect(coordinatesIt({ title: 'Add CSV import', role: 'work' })).toBe(
      'Add CSV import will coordinate it; its agent restarts as a coordinator.',
    );
    expect(coordinatesIt({ title: 'Shop', role: 'project' })).toBeUndefined();
    expect(coordinatesIt({ title: 'Checkout', role: 'coordinating' })).toBeUndefined();
    expect(coordinatesIt(undefined)).toBeUndefined();
  });

  test('a conversation has replied once its agent wrote a line', () => {
    const asked = [{ by: 'human', kind: 'event' }];
    expect(hasReplied('conversation', asked)).toBe(false);
    expect(hasReplied('conversation', [...asked, { by: 'agent:01X', kind: 'line' }])).toBe(true);
    expect(hasReplied('conversation', [{ by: 'agent:01X', kind: 'proposal' }])).toBe(false);
    expect(hasReplied('work', [{ by: 'agent:01X', kind: 'line' }])).toBe(false);
  });

  test('a title that is still the question is renamed; one you gave it stays', () => {
    const q = 'Does import handle Excel files?';
    expect(keepsTitle(q, q)).toBe(false);
    expect(keepsTitle(' Does import handle Excel files? ', q)).toBe(false);
    // Ask's placeholder: the question cut at a word.
    const long = 'Why does the importer read the whole file into memory before it parses a row?';
    expect(keepsTitle('Why does the importer read the whole file into memory before', long)).toBe(
      false,
    );
    expect(keepsTitle('Excel import', q)).toBe(true);
    // A title that asks names no work, whoever wrote it (Ask's is the cheap model's).
    expect(
      keepsTitle('Does import handle Excel files?', 'Does importCsv handle BOM and CRLF?'),
    ).toBe(false);
  });

  test('the composer focus Ask asks for is taken once, by that node only', () => {
    focusComposerOn('a');
    expect(takeComposerFocus('b')).toBe(false);
    expect(takeComposerFocus('a')).toBe(true);
    expect(takeComposerFocus('a')).toBe(false);
  });
});

describe('askHint', () => {
  test('says where the question goes and what it leaves alone', () => {
    expect(askHint(undefined)).toContain('Director’s thread');
    expect(askHint({ value: DIRECTOR_TARGET, title: 'The Director', depth: 0 })).toContain(
      'Director’s thread',
    );
    expect(askHint({ value: 'r', title: 'Shop', role: 'project', depth: 0 })).toBe(
      'A conversation under Shop: its own thread, with the project in view.',
    );
    expect(askHint({ value: 'a', title: 'api part', role: 'work', depth: 1 })).toBe(
      'A conversation under api part: its own thread, so api part’s work goes on undisturbed.',
    );
  });
});
