import { describe, expect, test } from 'vitest';
import { instrument } from '../src/instrument.ts';

const ignored = (src: string) =>
  instrument('a.js', src)
    .mutants.filter((m) => m.ignored)
    .map((m) => `${m.original} -> ${m.replacement} (${m.ignored})`);
const placed = (src: string) =>
  instrument('a.js', src)
    .mutants.filter((m) => !m.ignored)
    .map((m) => `${m.original} -> ${m.replacement}`);

describe('disable comments', () => {
  test('disable-next-line ignores every mutant starting on the next line', () => {
    const src = 'x = 1 + 1;\n// mutator-disable-next-line\ny = 2 + 2;\nz = 3 + 3;';
    expect(ignored(src)).toEqual(['2 + 2 -> 2 - 2 (disabled)']);
    expect(placed(src)).toEqual(['1 + 1 -> 1 - 1', '3 + 3 -> 3 - 3']);
  });

  test('disable-line applies to the comment line', () => {
    expect(ignored('y = 2 + 2; // mutator-disable-line')).toEqual(['2 + 2 -> 2 - 2 (disabled)']);
  });

  test('mutator names and reason', () => {
    const src = '// mutator-disable-next-line EqualityOperator: boundary is spec\nif (a < b) {}';
    const result = instrument('a.js', src).mutants;
    expect(result.filter((m) => m.mutator === 'EqualityOperator').every((m) => m.ignored === 'disabled: boundary is spec')).toBe(true);
    expect(result.filter((m) => m.mutator === 'ConditionalExpression').every((m) => !m.ignored)).toBe(true);
  });

  test('region disable / enable', () => {
    const src = 'a = 1 + 1;\n/* mutator-disable ArithmeticOperator */\nb = 2 + 2;\nc = "s";\n// mutator-enable ArithmeticOperator\nd = 3 + 3;';
    expect(ignored(src)).toEqual(['2 + 2 -> 2 - 2 (disabled)']);
    expect(placed(src)).toContain('"s" -> ""');
    expect(placed(src)).toContain('3 + 3 -> 3 - 3');
  });

  test('stryker comments are honoured for migration', () => {
    const src = '// Stryker disable next-line all\ny = 2 + 2;\n// Stryker disable all\nz = 3 + 3;\n// Stryker restore all\nw = 4 + 4;';
    expect(placed(src)).toEqual(['4 + 4 -> 4 - 4']);
  });

  test('disabled mutants are not placed', () => {
    const { code } = instrument('a.js', '// mutator-disable-next-line\ny = 2 + 2;');
    expect(code).not.toContain('__mutator_act');
  });
});
