import { describe, expect, test } from 'vitest';
import { instrument } from '../src/instrument.ts';

const RUNTIME = '__mutator__';

function dryRun(src: string, testIds: string[], body: (exports: any, setTest: (id: string | null) => void) => void) {
  const { code, mutants } = instrument('a.js', src);
  const state: any = { active: null, collect: true, cov: { static: {}, perTest: {} }, inf: { static: {}, perTest: {} }, testId: null, hits: 0, hitLimit: 1e6 };
  (globalThis as any)[RUNTIME] = state;
  const exports: any = {};
  new Function('exports', code)(exports);
  body(exports, (id) => (state.testId = id));
  void testIds;
  const label = (key: string) => {
    const m = mutants.find((m) => m.key === key)!;
    return `${m.original} -> ${m.replacement}`;
  };
  const infected = (id: string) => Object.keys(state.inf.perTest[id] ?? {}).map(label).sort();
  return { mutants, infected };
}

describe('weak mutation (infection) recording', () => {
  test('comparison and arithmetic swaps with pure operands are weak-checkable', () => {
    const { mutants } = instrument('a.js', 'exports.f = (a, b) => a < b; exports.g = (n, s) => (n - 2) * s.length; exports.h = (x, o) => x() > 1 && o.n > 0;');
    const weak = mutants.filter((m) => m.weak).map((m) => `${m.original} -> ${m.replacement}`).sort();
    expect(weak).toEqual(['a < b -> a <= b', 'a < b -> a >= b', 'a < b -> false', 'a < b -> true', 'n - 2 -> n + 2'].sort());
    // Calls and property reads (getters, proxies) may have side effects: never re-evaluated.
    expect(mutants.filter((m) => m.original === 'x() > 1' || m.original === 'o.n > 0').every((m) => !m.weak)).toBe(true);
  });

  test('records, per test, the mutants whose value differs from the original', () => {
    const { infected } = dryRun('exports.f = (a, b) => a < b;', [], (e, setTest) => {
      setTest('t1');
      e.f(1, 2); // a<b: true; a<=b: true (same); a>=b: false (differs); true (same); false (differs)
      setTest('t2');
      e.f(2, 2); // a<b: false; a<=b: true (differs); a>=b: true (differs); true (differs); false (same)
      setTest(null);
    });
    expect(infected('t1')).toEqual(['a < b -> a >= b', 'a < b -> false']);
    expect(infected('t2')).toEqual(['a < b -> a <= b', 'a < b -> a >= b', 'a < b -> true']);
  });

  test('a condition in a test position compares truthiness', () => {
    const { infected } = dryRun('exports.f = (flag) => { if (flag) return 1; return 0; };', [], (e, setTest) => {
      setTest('t1');
      e.f('yes'); // truthy: `true` behaves the same
      setTest(null);
    });
    expect(infected('t1')).toEqual(['flag -> false']);
  });

  test('dry runs never re-evaluate anything with possible side effects', () => {
    const { code } = instrument('a.js', 'let calls = 0; const o = { get n() { calls++; return 3; } }; exports.r = () => [o.n * 2, calls];');
    const state: any = { active: null, collect: true, cov: { static: {}, perTest: {} }, inf: { static: {}, perTest: {} }, testId: 't', hits: 0, hitLimit: 1e6 };
    (globalThis as any)[RUNTIME] = state;
    const exports: any = {};
    new Function('exports', code)(exports);
    expect(exports.r()).toEqual([6, 1]);
  });
});

describe('weak mutation never changes dry-run behaviour', () => {
  test('a BigInt product whose mutated division would throw (division by zero)', () => {
    const { code, mutants } = instrument('a.js', 'exports.f = (a, b) => a * b;');
    expect(mutants.filter((m) => m.original === 'a * b' && m.replacement === 'a / b').every((m) => !m.weak)).toBe(true);
    (globalThis as any)[RUNTIME] = { active: null, collect: true, cov: { static: {}, perTest: {} }, testId: 't', hits: 0, hitLimit: 1e6 };
    const exports: any = {};
    new Function('exports', code)(exports);
    expect(exports.f(3n, 0n)).toBe(0n);
  });
});
