import { describe, expect, test } from 'vitest';
import { instrument, numericMutations } from '../src/index.ts';

const source = 'export function tax(price: number) { return Math.floor(price * 0.1); }';
const edits = (options: Parameters<typeof numericMutations>[0], text = source) => instrument('tax.ts', text, {
  mutators: numericMutations(options).mutators ?? [],
}).mutants.filter((m) => m.mutator === 'MathRounding' || m.mutator === 'NumericConstant').map((m) => [m.original, m.replacement]);

describe('opt-in numeric mutations', () => {
  test('changes rounding methods independently from other methods', () => {
    expect(edits({ rounding: true })).toEqual([['floor', 'ceil'], ['floor', 'round'], ['floor', 'trunc']]);
    expect(edits({ rounding: true }, 'export const f = (o: any) => o.floor(1);')).toEqual([]);
  });

  test('replaces only explicitly configured constants, without equivalent duplicates', () => {
    expect(edits({ constants: [{ from: 0.1, to: [0.08, 0.1, 0.08] }] })).toEqual([['0.1', '0.08']]);
    expect(edits({})).toEqual([]);
  });

  test('negative constants are replaced as a whole', () => {
    expect(edits({ constants: [{ from: -0.1, to: [-0.08] }] }, 'export const f = () => -0.1;')).toEqual([['-0.1', '-0.08']]);
  });

  test('rejects non-finite constants', () => {
    expect(() => numericMutations({ constants: [{ from: 0.1, to: [Infinity] }] })).toThrow('finite');
  });
});
