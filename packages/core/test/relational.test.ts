import { describe, expect, test } from 'vitest';
import { instrument } from '../src/instrument.ts';

const comparisons = (src: string, minimal: boolean) => {
  const { mutants, skipped } = instrument('a.js', src, minimal ? { minimalRelational: true } : {});
  const at = (m: { mutator: string }) => m.mutator === 'EqualityOperator' || m.mutator === 'ConditionalExpression';
  return {
    placed: mutants.filter(at).map((m) => `${m.original} -> ${m.replacement}`).sort(),
    skipped: skipped.filter(at).map((s) => `${s.original} -> ${s.replacement} (${s.rule}, ${s.category})`).sort(),
  };
};

describe('relational operators', () => {
  test('default: both neighbours and both constants', () => {
    expect(comparisons('if (a < b) f();', false).placed).toEqual(['a < b -> a <= b', 'a < b -> a >= b', 'a < b -> false', 'a < b -> true']);
  });

  test.each([
    ['if (a < b) f();', ['a < b -> a != b', 'a < b -> a <= b', 'a < b -> false']],
    ['if (a <= b) f();', ['a <= b -> a < b', 'a <= b -> a == b', 'a <= b -> true']],
    ['x = a > b;', ['a > b -> a != b', 'a > b -> a >= b', 'a > b -> false']],
    ['x = a >= b;', ['a >= b -> a == b', 'a >= b -> a > b', 'a >= b -> true']],
  ])('minimal: %s', (src, expected) => {
    expect(comparisons(src, true).placed).toEqual(expected);
  });

  test('minimal leaves equality operators as they are', () => {
    expect(comparisons('if (a === b) f();', true).placed).toEqual(comparisons('if (a === b) f();', false).placed);
  });

  test('minimal: a constant equal to the comparison under a lower bound is skipped as equivalent', () => {
    const { placed, skipped } = comparisons('if (s.length >= 0) f();', true);
    expect(placed).toEqual(['s.length >= 0 -> s.length == 0', 's.length >= 0 -> s.length > 0']);
    expect(skipped).toEqual(['s.length >= 0 -> true (lower-bound, equivalent)']);
  });

  test('minimal: `indexOf(x) > -1` -> `!= -1` is equivalent; the other replacements are not', () => {
    const { placed, skipped } = comparisons('if (xs.indexOf(x) > -1) f();', true);
    expect(skipped).toEqual(['xs.indexOf(x) > -1 -> xs.indexOf(x) != -1 (lower-bound, equivalent)']);
    expect(placed).toEqual(['xs.indexOf(x) > -1 -> false', 'xs.indexOf(x) > -1 -> xs.indexOf(x) >= -1']);
  });

  test('minimal: the bound applies with the literal on the left too', () => {
    const { skipped } = comparisons('if (0 <= s.length) f();', true);
    expect(skipped).toEqual(['0 <= s.length -> true (lower-bound, equivalent)']);
  });

  test('minimal: a split result has at least one element', () => {
    const { skipped } = comparisons('if (s.split("@").length > 1) f();', true);
    expect(skipped).toEqual(['s.split("@").length > 1 -> s.split("@").length != 1 (lower-bound, equivalent)']);
  });
});
