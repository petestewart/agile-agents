import { describe, expect, test } from 'bun:test';
import {
  AUTONOMY_LEVELS,
  COORDINATOR_AUTONOMY,
  autonomyOption,
  confirmsRun,
  inheritsOption,
  runConfirm,
} from './autonomy';
import { DIRECTOR_AUTONOMY } from './director';

describe('autonomy in words (T423)', () => {
  test('every level reads capitalised, with a few words and a sentence, for both', () => {
    for (const words of [COORDINATOR_AUTONOMY, DIRECTOR_AUTONOMY]) {
      for (const level of AUTONOMY_LEVELS) {
        expect(words[level].label).toMatch(/^[A-Z]/);
        expect(words[level].short).toMatch(/^[a-z]/);
        expect(words[level].hint).toMatch(/\.$/);
      }
    }
  });

  test('options: "Advise — proposes, you apply"; the Director reads as its own panel', () => {
    expect(autonomyOption('coordinator', 'advise')).toBe('Advise — proposes, you apply');
    expect(autonomyOption('director', 'organise')).toBe('Organise — creates and starts');
    expect(inheritsOption('advise')).toBe('Inherits Advise from the project');
  });

  test('only a change up to Run asks first', () => {
    expect(confirmsRun('advise', 'run')).toBe(true);
    expect(confirmsRun('organise', 'run')).toBe(true);
    expect(confirmsRun('run', 'run')).toBe(false);
    expect(confirmsRun('run', 'advise')).toBe(false);
    expect(confirmsRun('advise', 'organise')).toBe(false);
    expect(runConfirm('director', 'Shop').title).toBe('Let the Director run Shop on its own?');
    expect(runConfirm('coordinator', 'Shop').confirm).toBe('Set to Run');
  });
});
