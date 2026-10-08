import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { parseSync } from 'oxc-parser';
import { describe, expect, test } from 'vitest';
import { applyMutant, instrument } from '../src/instrument.ts';
import { regexMutations } from '../src/regex.ts';
import type { Mutant, MutatorName } from '../src/types.ts';

const summary = (mutants: Mutant[], only?: MutatorName) =>
  mutants.filter((m) => !only || m.mutator === only).map((m) => `${m.mutator}: ${m.original} -> ${m.replacement}`);

describe('regexMutations', () => {
  test('anchors', () => {
    expect(regexMutations('^abc$', '')).toEqual(expect.arrayContaining(['abc$', '^abc']));
  });

  test('character class negation', () => {
    expect(regexMutations('[abc]', '')).toContain('[^abc]');
    expect(regexMutations('[^abc]', '')).toContain('[abc]');
  });

  test('predefined classes', () => {
    expect(regexMutations('\\d\\w\\s', '')).toEqual(expect.arrayContaining(['\\D\\w\\s', '\\d\\W\\s', '\\d\\w\\S']));
    expect(regexMutations('\\D\\W\\S', '')).toEqual(expect.arrayContaining(['\\d\\W\\S', '\\D\\w\\S', '\\D\\W\\s']));
  });

  test('quantifiers', () => {
    expect(regexMutations('a*b?c+', '')).toEqual(expect.arrayContaining(['ab?c+', 'a*bc+', 'a*b?c']));
    expect(regexMutations('a{1,3}', '')).toContain('a{1}');
    expect(regexMutations('a{2,}', '')).toContain('a{2}');
    expect(regexMutations('a{2}', '')).toEqual([]);
    expect(regexMutations('a+?', '')).toEqual(['a']);
  });

  test('escapes and classes are respected', () => {
    expect(regexMutations('\\^\\$\\+', '')).toEqual([]);
    // `^` / `$` inside a class are not anchors; only the negation toggle applies.
    expect(regexMutations('[$^]', '')).toEqual(['[^$^]']);
    expect(regexMutations('[\\]^]', '')).toEqual(['[^\\]^]']);
    // `?` right after `(` is group syntax, not a quantifier.
    expect(regexMutations('(?:a)', '')).toEqual([]);
    expect(regexMutations('(?<n>a)', '')).toEqual([]);
    expect(regexMutations('\\p{L}+', 'u')).toEqual(['\\p{L}']);
    expect(regexMutations('\\u{1F600}', 'u')).toEqual([]);
  });

  test('never yields an invalid or unchanged pattern', () => {
    // Negated classes may not contain strings in v-mode.
    expect(regexMutations('[\\q{abc}]', 'v')).not.toContain('[^\\q{abc}]');
    for (const [pattern, flags] of [['^(a+)+$', ''], ['[^]', ''], ['\\k<x>(?<x>a)*', ''], ['[a-z]{1,2}\\d*', 'gu'], ['a|^b|c$', 'm']] as const) {
      for (const m of regexMutations(pattern, flags)) {
        expect(m).not.toBe(pattern);
        expect(() => new RegExp(m, flags)).not.toThrow();
      }
    }
  });
});

describe('Regex mutator', () => {
  test('regex literals keep their flags', () => {
    const { mutants } = instrument('a.js', 'x = /^a+$/gi;');
    expect(summary(mutants, 'Regex')).toEqual(
      expect.arrayContaining(['Regex: /^a+$/gi -> /a+$/gi', 'Regex: /^a+$/gi -> /^a+/gi', 'Regex: /^a+$/gi -> /^a$/gi']),
    );
  });

  test('RegExp constructor string argument', () => {
    const { mutants } = instrument('a.js', 'x = new RegExp("^a", "g"); y = RegExp(\'\\\\d\');');
    expect(summary(mutants, 'Regex')).toEqual(['Regex: "^a" -> "a"', "Regex: '\\\\d' -> \"\\\\D\""]);
  });

  test('never produces an empty regex literal (a comment)', () => {
    const { mutants } = instrument('a.js', 'x = /^/;');
    expect(summary(mutants, 'Regex')).toEqual([]);
  });
});

describe('CallExpression mutator', () => {
  test('call statements are emptied', () => {
    const { mutants } = instrument('a.js', 'f(); a.b(c); g(1 + 2);');
    expect(summary(mutants, 'CallExpression')).toEqual(['CallExpression: f(); -> ;', 'CallExpression: a.b(c); -> ;']);
  });

  test('not for super(), throw, or statements that already carry mutants', () => {
    const src = 'class B extends A { constructor() { super(); } } function t() { throw new Error(x); } arr.sort(); h(() => { k(1 + 1); });';
    const { mutants } = instrument('a.js', src);
    expect(summary(mutants, 'CallExpression')).toEqual([]);
  });

  test('suppression does not depend on the ranges option', () => {
    const src = 'f(a + b);';
    const { mutants } = instrument('a.js', src, { ranges: [{ start: 0, end: 2 }] });
    expect(summary(mutants, 'CallExpression')).toEqual([]);
  });
});

describe('ConditionalExpression for (;;)', () => {
  const forMutants = (src: string) =>
    instrument('a.js', src)
      .mutants.filter((m) => m.mutator === 'ConditionalExpression' && m.original === '')
      .map((m) => applyMutant(src, m));

  test('inserts false into the empty test slot', () => {
    expect(forMutants('for (;;) { break; }')).toEqual(['for (;false;) { break; }']);
    expect(forMutants('for (let i = 0; ; i++) { break; }')).toEqual(['for (let i = 0;false ; i++) { break; }']);
  });

  test('skips comments and strings in the header', () => {
    expect(forMutants('for (/*;*/ ; /* ; */ ;) break;')).toEqual(['for (/*;*/ ;false /* ; */ ;) break;']);
    expect(forMutants('for (let s = ";"; ;) break;')).toEqual(['for (let s = ";";false ;) break;']);
    expect(forMutants('for (let i = (0, 1)\n// ;\n; ;) break;')).toEqual(['for (let i = (0, 1)\n// ;\n;false ;) break;']);
  });

  test('loops with a test are untouched by this rule', () => {
    expect(forMutants('for (let i = 0; i < 1; i++) {}')).toEqual([]);
  });
});

describe('FnValue mutator', () => {
  const fnValues = (src: string) => summary(instrument('a.ts', src).mutants, 'FnValue');

  test('primitive return types', () => {
    expect(fnValues('function f(): boolean { return g(); }')).toEqual([
      'FnValue: { return g(); } -> { return true; }',
      'FnValue: { return g(); } -> { return false; }',
    ]);
    expect(fnValues('function f(): number { return g(); }').map((s) => s.split(' -> ')[1])).toEqual([
      '{ return 0; }',
      '{ return 1; }',
      '{ return -1; }',
    ]);
    expect(fnValues('function f(): string { return g(); }').map((s) => s.split(' -> ')[1])).toEqual(['{ return ""; }', '{ return "xyzzy"; }']);
    expect(fnValues('function f(): bigint { return g(); }').map((s) => s.split(' -> ')[1])).toEqual(['{ return 0n; }', '{ return 1n; }']);
  });

  test('arrays, literals, unions, null / undefined', () => {
    const values = (src: string) => fnValues(src).map((s) => s.split(' -> ')[1]);
    expect(values('function f(): number[] { return g(); }')).toEqual(['{ return []; }']);
    expect(values('function f(): Array<number> { return g(); }')).toEqual(['{ return []; }']);
    expect(values('function f(): readonly string[] { return g(); }')).toEqual(['{ return []; }']);
    expect(values("function f(): 'a' | 'b' | 2 | -1 { return g(); }")).toEqual([
      '{ return "a"; }',
      '{ return "b"; }',
      '{ return 2; }',
      '{ return -1; }',
    ]);
    expect(values('function f(): string | null { return g(); }')).toEqual(['{ return ""; }', '{ return "xyzzy"; }', '{ return null; }']);
    // `{ return undefined; }` is the same as BlockStatement's `{}`.
    expect(values('function f(): number | undefined { return g(); }')).toEqual(['{ return 0; }', '{ return 1; }', '{ return -1; }']);
    expect(values('function f(): undefined | null { return g(); }')).toEqual(['{ return null; }']);
    expect(values('function f(): (boolean) { return g(); }')).toEqual(['{ return true; }', '{ return false; }']);
    expect(values('function f(x: unknown): x is string { return g(); }')).toEqual(['{ return true; }', '{ return false; }']);
    expect(values('function f(x: unknown): asserts x is string { g(); }')).toEqual([]);
  });

  test('promises', () => {
    const values = (src: string) => fnValues(src).map((s) => s.split(' -> ')[1]);
    expect(values('async function f(): Promise<boolean> { return g(); }')).toEqual(['{ return true; }', '{ return false; }']);
    expect(values('function f(): Promise<number[]> { return g(); }')).toEqual(['{ return Promise.resolve([]); }']);
    expect(values('function f(): Promise<void> { return g(); }')).toEqual(['{ return Promise.resolve(undefined); }']);
    // Same as BlockStatement's `{}`.
    expect(values('async function f(): Promise<void> { await g(); }')).toEqual([]);
  });

  test('skipped functions and types', () => {
    const src = [
      'class C { constructor() {} get x(): number { return g(); } set x(v: number) {} m(): void { g(); } }',
      'function* gen(): Generator<number> { yield 1; } function* gb(): boolean { yield 1; }',
      'function a(): any { return g(); } function u(): unknown { return g(); } function n(): never { throw g(); }',
      'function o(): object { return g(); } function r(): Foo { return g(); } function t(): [number] { return g(); }',
      'function nr(x) { return x; }',
      'const obj = { get y(): number { return g(); } };',
    ].join('\n');
    expect(fnValues(src)).toEqual([]);
  });

  test('void is left to BlockStatement (no duplicate edit)', () => {
    const { mutants } = instrument('a.ts', 'function f(): void { g(); }');
    expect(mutants.filter((m) => m.replacement === '{}').map((m) => m.mutator)).toEqual(['BlockStatement']);
    expect(summary(mutants, 'FnValue')).toEqual([]);
  });

  test('skips a candidate equal to the existing body', () => {
    const values = (src: string) => fnValues(src).map((s) => s.split(' -> ')[1]);
    expect(values('function f(): boolean { return true; }')).toEqual(['{ return false; }']);
    expect(values("function f(): string { return ''; }")).toEqual(['{ return "xyzzy"; }']);
    expect(values('function f(): number { return  -1 }')).toEqual(['{ return 0; }', '{ return 1; }']);
    expect(values('const f = (): number => 0;')).toEqual(['1', '-1']);
  });

  test('arrow functions with expression bodies', () => {
    const { mutants } = instrument('a.ts', 'const f = (x: number): boolean => g(x);\nconst g = async (): Promise<string[]> => h();');
    expect(summary(mutants, 'FnValue')).toEqual([
      'FnValue: g(x) -> true',
      'FnValue: g(x) -> false',
      'FnValue: h() -> []',
    ]);
  });

  test('identical edits keep the established mutator name', () => {
    const { mutants } = instrument('a.ts', 'const f = (x: number): boolean => x > 1;');
    expect(summary(mutants).filter((s) => s.includes('x > 1 -> true') || s.includes('x > 1 -> false'))).toEqual([
      'ConditionalExpression: x > 1 -> true',
      'ConditionalExpression: x > 1 -> false',
    ]);
  });

  test('methods and function expressions', () => {
    const values = fnValues('class K { m(): number { return g(); } static s(): boolean { return g(); } }\nconst e = function (): string { return g(); };');
    expect(values.length).toBe(3 + 2 + 2);
  });
});

// Behavioural oracle for TS: strip types (erasable syntax only), then compare the
// instrumented program with mutant k active against the source with only k applied.
function run(tsCode: string, active: string | null): unknown {
  const js = stripTypeScriptTypes(tsCode);
  const context = vm.createContext({
    exports: {},
    __mutator__: { active, cov: { static: {}, perTest: {} }, testId: null, hits: 0, hitLimit: 10_000 },
  });
  vm.runInContext(js, context, { timeout: 200 });
  return JSON.parse(JSON.stringify(context.exports));
}

const tsCorpus: Record<string, string> = {
  fnValue: [
    'function isBig(n: number): boolean { return n > 10; }',
    'function count(xs: number[]): number { let c = 0; for (const x of xs) c += x; return c; }',
    'function label(n: number): "lo" | "hi" { if (n > 1) { return "hi"; } return "lo"; }',
    'function name(): string | null { return "n"; }',
    'function list(): readonly number[] { return [1, 2]; }',
    'function big(): bigint { return 5n; }',
    'const arrow = (a: number): number => a * 2;',
    'class K { v(): number { return 7; } }',
    'exports.r = [isBig(3), isBig(30), count([1, 2]), label(0), label(2), name(), list(), String(big()), arrow(2), new K().v()];',
  ].join('\n'),
  calls: 'const log: number[] = []; function push(n: number): void { log.push(n); } push(1); push(2); log.reverse(); exports.r = log;',
  infiniteFor: 'let i = 0; for (;;) { i++; if (i > 3) break; } exports.r = i;',
  regex: [
    "const re = /^a+\\d*$/i; const ctor = new RegExp('[^b]{1,3}', 'g');",
    "exports.r = [re.test('AA12'), re.test('a'), re.test('xa1'), 'abcbb'.match(ctor), /\\s\\w?/.test(' ')];",
  ].join('\n'),
};

describe('TS mutation switching oracle', () => {
  for (const [name, src] of Object.entries(tsCorpus)) {
    test(name, () => {
      const { code, mutants } = instrument(`${name}.ts`, src);
      expect(parseSync(`${name}.ts`, code).errors).toEqual([]);
      expect(run(code, null)).toEqual(run(src, null));
      const placed = mutants.filter((m) => !m.ignored);
      expect(placed.length).toBeGreaterThan(0);
      for (const m of placed) {
        const label = `${m.mutator} ${m.original} -> ${m.replacement}`;
        let expected: unknown;
        let expectedError = false;
        try {
          expected = run(applyMutant(src, m), null);
        } catch {
          expectedError = true;
        }
        if (expectedError) expect(() => run(code, m.key), label).toThrow();
        else expect(run(code, m.key), label).toEqual(expected);
      }
    });
  }

  test('every new mutator is exercised by the TS corpus', () => {
    const names = new Set(Object.entries(tsCorpus).flatMap(([n, s]) => instrument(`${n}.ts`, s).mutants.filter((m) => !m.ignored).map((m) => m.mutator)));
    for (const n of ['Regex', 'CallExpression', 'FnValue', 'ConditionalExpression'] as const) expect(names).toContain(n);
  });
});

describe('instrumented TS output re-parses', () => {
  test('mixed sample', () => {
    const src = [
      'export async function load(url: string): Promise<string[] | undefined> { const r = await fetch(url); return (await r.json()) as string[]; }',
      'export const pick = <T,>(xs: readonly T[]): T[] => xs.filter((x) => x != null);',
      'export function tag(): `a` | 1n { return 1n; }',
      'export abstract class Base { abstract area(): number; size(): number { return this.area() * 2; } }',
      'export function overload(a: string): string; export function overload(a: number): number; export function overload(a: any): any { return a; }',
      'for (;;) { if (/^x$/u.test(String(Math.random()))) break; }',
      'console.log(new RegExp(`^${1}`));',
    ].join('\n');
    const { code, mutants } = instrument('m.ts', src);
    expect(parseSync('m.ts', code).errors).toEqual([]);
    expect(mutants.some((m) => m.mutator === 'FnValue')).toBe(true);
  });
});
