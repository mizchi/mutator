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

describe('subsumeCoarse (solitary rule)', () => {
  const src = 'function f(a) {\n  if (a) {\n    return a + 1;\n  }\n  return 0;\n}';
  const block = 'BlockStatement: { return a + 1; } -> {}';

  test('off by default: a coarse mutant with a finer one inside is kept', () => {
    const { mutants, skipped } = instrument('a.js', src);
    expect(mutants.map(label)).toContain(block);
    expect(skipped.filter((s) => s.rule === 'solitary')).toEqual([]);
  });

  test('on: the coarse mutant is skipped as subsumed by a finer mutant inside it', () => {
    const { mutants, skipped } = instrument('a.js', src, { subsumeCoarse: true });
    expect(mutants.map(label)).not.toContain(block);
    const skip = skipped.find((s) => s.rule === 'solitary' && s.mutator === 'BlockStatement' && s.original.includes('a + 1'))!;
    expect(skip).toMatchObject({ category: 'subsumed', heuristic: true });
    const by = mutants.find((m) => m.key === skip.by)!;
    expect(by.range.start).toBeGreaterThanOrEqual(skip.range.start);
    expect(by.range.end).toBeLessThanOrEqual(skip.range.end);
  });

  test('on: a mutant over the same range is not finer, and keys of the rest stay the same', () => {
    const arrow = 'const p = (a: number): boolean => a > 1;';
    const off = instrument('a.ts', arrow).mutants.map((m) => m.key);
    const on = instrument('a.ts', arrow, { subsumeCoarse: true }).mutants.map((m) => m.key);
    expect(on.every((k) => off.includes(k))).toBe(true);
    const whole = instrument('a.js', src, { subsumeCoarse: true }).mutants.filter((m) => m.mutator === 'BlockStatement').map(label);
    // The function body still holds finer mutants, so it goes too; an empty-able block without inner mutants stays.
    expect(whole).toEqual([]);
  });
});

describe('skip keys', () => {
  test('a skipped candidate carries the key it has as a mutant when the rule is off', () => {
    const src = 'function f(a) {\n  if (a) {\n    return a + 1;\n  }\n  return 0;\n}';
    const off = instrument('a.js', src).mutants;
    const { skipped } = instrument('a.js', src, { subsumeCoarse: true });
    const solitary = skipped.filter((s) => s.rule === 'solitary');
    expect(solitary.length).toBeGreaterThan(0);
    for (const s of solitary) expect(off.find((m) => m.key === s.key)?.replacement).toBe(s.replacement);
  });
});
