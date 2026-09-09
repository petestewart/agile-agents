import { describe, expect, test } from 'bun:test';
import { type FourQuestionAnswers, pointTicket, validateFourQuestionAnswers } from './rubric';

/** Three fixture tickets (ticket acceptance: "pointing on three fixture tickets matches the expected tiers"). */
describe('pointTicket — fixtures', () => {
  test('fixture A: rename a variable, exact precedent -> trivial', () => {
    const answers: FourQuestionAnswers = {
      points: 1,
      ambiguity: 'contract_specified',
      blastRadius: 'one_module',
      verifiability: 'executable_tests',
      precedent: 'exact_pattern',
    };
    const result = pointTicket(answers);
    expect(result.tier).toBe('trivial');
    expect(result.reasoning).toBe('low');
    expect(result.points).toBe(1);
  });

  test('fixture B: new endpoint, similar precedent only -> standard', () => {
    const answers: FourQuestionAnswers = {
      points: 3,
      ambiguity: 'contract_specified',
      blastRadius: 'one_module',
      verifiability: 'executable_tests',
      precedent: 'similar_pattern',
    };
    const result = pointTicket(answers);
    expect(result.tier).toBe('standard');
    expect(result.reasoning).toBe('low');
  });

  test('fixture C: cross-module auth rework, needs judgment -> hard', () => {
    const answers: FourQuestionAnswers = {
      points: 5,
      ambiguity: 'contract_specified',
      blastRadius: 'bounded_context',
      verifiability: 'needs_judgment',
      precedent: 'none',
    };
    const result = pointTicket(answers);
    expect(result.tier).toBe('hard');
    expect(result.reasoning).toBe('medium');
  });
});

describe('pointTicket — edge rows', () => {
  test('any single novel answer forces novel regardless of the others', () => {
    const result = pointTicket({
      points: 8,
      ambiguity: 'choices_are_decisions',
      blastRadius: 'one_module',
      verifiability: 'executable_tests',
      precedent: 'exact_pattern',
    });
    expect(result.tier).toBe('novel');
    expect(result.reasoning).toBe('high');
  });

  test('public interface / data model blast radius alone forces novel', () => {
    const result = pointTicket({
      points: 5,
      ambiguity: 'contract_specified',
      blastRadius: 'public_interface_or_data_model',
      verifiability: 'executable_tests',
      precedent: 'similar_pattern',
    });
    expect(result.tier).toBe('novel');
  });

  test('"can\'t be written until done" verifiability alone forces novel (it\'s a spike)', () => {
    const result = pointTicket({
      points: 3,
      ambiguity: 'contract_specified',
      blastRadius: 'one_module',
      verifiability: 'cant_be_written_until_done',
      precedent: 'exact_pattern',
    });
    expect(result.tier).toBe('novel');
  });

  test('no precedent at all, but otherwise low, settles at hard (never novel by precedent alone)', () => {
    const result = pointTicket({
      points: 5,
      ambiguity: 'contract_specified',
      blastRadius: 'one_module',
      verifiability: 'executable_tests',
      precedent: 'none',
    });
    expect(result.tier).toBe('hard');
  });

  test('hard beats a merged-low reading even when mixed with a lower answer elsewhere', () => {
    const result = pointTicket({
      points: 3,
      ambiguity: 'requires_choices',
      blastRadius: 'one_module',
      verifiability: 'executable_tests',
      precedent: 'exact_pattern',
    });
    expect(result.tier).toBe('hard');
  });

  test('reasoningOverride wins over the tier default', () => {
    const result = pointTicket({
      points: 1,
      ambiguity: 'contract_specified',
      blastRadius: 'one_module',
      verifiability: 'executable_tests',
      precedent: 'exact_pattern',
      reasoningOverride: 'high',
    });
    expect(result.tier).toBe('trivial');
    expect(result.reasoning).toBe('high');
  });

  test('points pass through unchanged', () => {
    const result = pointTicket({
      points: 8,
      ambiguity: 'choices_are_decisions',
      blastRadius: 'one_module',
      verifiability: 'executable_tests',
      precedent: 'exact_pattern',
    });
    expect(result.points).toBe(8);
  });
});

/**
 * Independent review fix (opus blocker 1): an unrecognised answer value must
 * be refused, never silently coerced to the worst tier by falling through
 * the ternary chain's final `else`.
 */
describe('pointTicket / validateFourQuestionAnswers — rejects bad input', () => {
  const valid = {
    points: 1,
    ambiguity: 'contract_specified',
    blastRadius: 'one_module',
    verifiability: 'executable_tests',
    precedent: 'exact_pattern',
  } as const;

  test('an unrecognised ambiguity value throws, not coerces to novel', () => {
    expect(() => pointTicket({ ...valid, ambiguity: 'somehow_both' })).toThrow();
  });

  test('an unrecognised blastRadius value throws', () => {
    expect(() => pointTicket({ ...valid, blastRadius: 'the whole repo' })).toThrow();
  });

  test('an unrecognised verifiability value throws', () => {
    expect(() => pointTicket({ ...valid, verifiability: 'vibes' })).toThrow();
  });

  test('an unrecognised precedent value throws', () => {
    expect(() => pointTicket({ ...valid, precedent: 'maybe' })).toThrow();
  });

  test('a non-Fibonacci points value throws', () => {
    expect(() => pointTicket({ ...valid, points: 4 })).toThrow();
  });

  test('an unrecognised reasoningOverride value throws', () => {
    expect(() => pointTicket({ ...valid, reasoningOverride: 'extreme' })).toThrow();
  });

  test('an unknown extra key is refused (.strict())', () => {
    expect(() => pointTicket({ ...valid, extraField: 'nope' })).toThrow();
  });

  test('a missing required field throws', () => {
    const { precedent: _drop, ...missingPrecedent } = valid;
    expect(() => pointTicket(missingPrecedent)).toThrow();
  });

  test('null/non-object input throws', () => {
    expect(() => pointTicket(null)).toThrow();
    expect(() => pointTicket('novel')).toThrow();
  });

  test('validateFourQuestionAnswers accepts valid input and returns it typed', () => {
    const result = validateFourQuestionAnswers(valid);
    expect(result).toEqual(valid);
  });
});
