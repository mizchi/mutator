import { describe, expect, test } from 'vitest';
import { instrument } from '../src/instrument.ts';

const label = (m: { mutator: string; original: string; replacement: string }) => `${m.mutator}: ${m.original.replace(/\s+/g, ' ')} -> ${m.replacement}`;

describe('skip records', () => {
  test('a call-statement removal with a finer mutant inside is recorded as subsumed, not dropped silently', () => {
    const { mutants, skipped } = instrument('a.js', 'function f(a) { g(a + 1); }');
    expect(mutants.map(label)).not.toContain('CallExpression: g(a + 1); -> ;');
    const skip = skipped.find((s) => s.mutator === 'CallExpression');
    expect(skip).toMatchObject({ rule: 'redundant-call', category: 'subsumed', heuristic: true, original: 'g(a + 1);', replacement: ';' });
    const by = mutants.find((m) => m.key === skip!.by);
    expect(by && label(by)).toBe('ArithmeticOperator: a + 1 -> a - 1');
    expect(skip!.location.start.line).toBe(1);
  });

  test('an ignored inner mutant still justifies the skip, so ignoring code adds no mutant', () => {
    const src = 'function f(a) {\n  // mutator-disable-next-line ArithmeticOperator\n  g(a + 1);\n}';
    const { mutants, skipped } = instrument('a.js', src);
    const skip = skipped.find((s) => s.rule === 'redundant-call')!;
    expect(mutants.find((m) => m.key === skip.by)?.ignored).toBe('disabled');
    expect(mutants.map(label)).not.toContain('CallExpression: g(a + 1); -> ;');
  });

  test('a call statement whose only inner mutant is excluded keeps its removal', () => {
    const { mutants, skipped } = instrument('a.js', 'function f(a) { g(a + 1); }', { excludedMutators: ['ArithmeticOperator'] });
    expect(skipped).toEqual([]);
    expect(mutants.map(label)).toContain('CallExpression: g(a + 1); -> ;');
  });

  test('a low-priority mutator making the same edit is recorded as a duplicate of the established one', () => {
    const { mutants, skipped } = instrument('a.ts', 'const f = (a: number): boolean => a > 1;');
    const dups = skipped.filter((s) => s.category === 'duplicate');
    expect(dups.map((s) => `${s.mutator}: ${s.original} -> ${s.replacement}`).sort()).toEqual(['FnValue: a > 1 -> false', 'FnValue: a > 1 -> true']);
    for (const s of dups) {
      expect(s.rule).toBe('same-edit');
      const first = mutants.find((m) => m.key === s.by)!;
      expect(first.mutator).toBe('ConditionalExpression');
      expect(first.replacement).toBe(s.replacement);
    }
  });

  test('a skip outside the requested ranges is not reported', () => {
    const src = 'function f(a) { g(a + 1); }\nfunction h(b) { k(b + 1); }';
    const second = src.indexOf('function h');
    const { skipped } = instrument('a.js', src, { ranges: [{ start: second, end: src.length }] });
    expect(skipped.map((s) => s.original)).toEqual(['k(b + 1);']);
  });
});
