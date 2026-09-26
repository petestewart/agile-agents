/** T419 (D42): Ask's targets and words. */

import { describe, expect, test } from 'bun:test';
import { DIRECTOR_TARGET, askHint, askTargets } from './ask';
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
