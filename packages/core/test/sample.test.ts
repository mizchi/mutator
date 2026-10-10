import { describe, expect, it } from 'vitest';
import { MUTATOR_PRODUCTIVITY, estimatedCost, orderByCost, selectPerLine } from '../src/sample.ts';
import { BUILTIN_MUTATOR_NAMES, type Mutant } from '../src/types.ts';

function mutant(key: string, opts: { file?: string; line?: number; mutator?: string; ignored?: string } = {}): Mutant {
  const line = opts.line ?? 1;
  const loc = { start: { line, column: 0 }, end: { line, column: 1 } };
  const m: Mutant = {
    key,
    file: opts.file ?? 'a.ts',
    mutator: opts.mutator ?? 'ArithmeticOperator',
    range: { start: 0, end: 1 },
    location: loc,
    original: '+',
    replacement: '-',
    scope: { id: 'f', hash: 'h', range: { start: 0, end: 10 }, location: loc },
  };
  if (opts.ignored !== undefined) m.ignored = opts.ignored;
  return m;
}

describe('selectPerLine', () => {
  it('keeps the most productive mutator of each line', () => {
    const mutants = [
      mutant('s', { mutator: 'StringLiteral' }),
      mutant('c', { mutator: 'ConditionalExpression' }),
      mutant('e', { mutator: 'EqualityOperator' }),
      mutant('b', { mutator: 'BlockStatement', line: 2 }),
      mutant('a', { mutator: 'ArithmeticOperator', line: 2 }),
    ];
    expect(selectPerLine(mutants, 1)).toEqual(new Set(['e', 'a']));
    expect(selectPerLine(mutants, 2)).toEqual(new Set(['e', 'c', 'a', 'b']));
  });

  it('groups by file and line', () => {
    const mutants = [mutant('x', { file: 'a.ts' }), mutant('y', { file: 'b.ts' }), mutant('z', { file: 'a.ts', line: 3 })];
    expect(selectPerLine(mutants, 1)).toEqual(new Set(['x', 'y', 'z']));
  });

  it('never selects ignored mutants and lets the next one take the slot', () => {
    const mutants = [mutant('e', { mutator: 'EqualityOperator', ignored: 'disabled' }), mutant('s', { mutator: 'StringLiteral' })];
    expect(selectPerLine(mutants, 1)).toEqual(new Set(['s']));
  });

  it('ranks custom mutators after built-ins, by name', () => {
    const mutants = [mutant('z', { mutator: 'Zeta' }), mutant('a', { mutator: 'Alpha' }), mutant('f', { mutator: 'FnValue' })];
    expect(selectPerLine(mutants, 1)).toEqual(new Set(['f']));
    expect(selectPerLine(mutants.filter((m) => m.key !== 'f'), 1)).toEqual(new Set(['a']));
  });

  it('breaks ties deterministically, independent of input order', () => {
    const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const forward = selectPerLine(keys.map((k) => mutant(k)), 3);
    const backward = selectPerLine([...keys].reverse().map((k) => mutant(k)), 3);
    expect(forward.size).toBe(3);
    expect(backward).toEqual(forward);
    // Not simply the lexicographically first keys: ties are spread by a hash.
    expect([...forward].sort()).not.toEqual(['k0', 'k1', 'k10']);
  });

  it('ranks every built-in mutator', () => {
    expect([...MUTATOR_PRODUCTIVITY].sort()).toEqual([...BUILTIN_MUTATOR_NAMES].sort());
  });

  it('rejects a non-positive count', () => {
    expect(() => selectPerLine([mutant('a')], 0)).toThrow();
  });
});

describe('orderByCost', () => {
  it('orders cheapest first with a stable key tie-break', () => {
    const items = [
      { key: 'b', cost: 5 },
      { key: 'c', cost: 1 },
      { key: 'a', cost: 5 },
    ];
    expect(orderByCost(items, (i) => i.cost, (i) => i.key).map((i) => i.key)).toEqual(['c', 'a', 'b']);
    expect(items.map((i) => i.key)).toEqual(['b', 'c', 'a']);
  });
});

describe('estimatedCost', () => {
  it('sums the durations of the selected tests (unknown tests count as 0)', () => {
    const durations = new Map([
      ['t1', 10],
      ['t2', 25],
    ]);
    expect(estimatedCost(['t1', 't2', 'tx'], durations)).toBe(35);
    expect(estimatedCost([], durations)).toBe(0);
  });
});
