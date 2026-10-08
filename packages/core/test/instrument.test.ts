import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { applyMutant, instrument } from '../src/instrument.ts';
import type { Mutant } from '../src/types.ts';

const RUNTIME = '__mutator__';

/** Evaluate CommonJS-ish snippet that assigns to `exports`. */
function evaluate(code: string, active: string | null): Record<string, unknown> {
  (globalThis as any)[RUNTIME] = { active, cov: { static: {}, perTest: {} }, testId: null, hits: 0, hitLimit: 1e6 };
  const exports: Record<string, unknown> = {};
  new Function('exports', code)(exports);
  return exports;
}

/** Sandboxed evaluation with a wall-clock limit; returns JSON-normalized exports. */
function evaluateIsolated(code: string, active: string | null): unknown {
  const context = vm.createContext({
    exports: {},
    [RUNTIME]: { active, cov: { static: {}, perTest: {} }, testId: null, hits: 0, hitLimit: 10_000 },
  });
  vm.runInContext(code, context, { timeout: 200 });
  return JSON.parse(JSON.stringify(context.exports));
}

function summary(mutants: Mutant[]) {
  return mutants.map((m) => `${m.mutator}: ${m.original} -> ${m.replacement}`);
}

describe('mutant discovery', () => {
  test('arithmetic', () => {
    const { mutants } = instrument('a.js', 'exports.f = (a, b) => a + b * c;');
    expect(summary(mutants)).toEqual(
      expect.arrayContaining(['ArithmeticOperator: a + b * c -> a - b * c', 'ArithmeticOperator: b * c -> b / c']),
    );
  });

  test('equality emits boundary and negation mutants', () => {
    const { mutants } = instrument('a.js', 'if (a < b) {}');
    expect(summary(mutants)).toEqual(
      expect.arrayContaining([
        'EqualityOperator: a < b -> a <= b',
        'EqualityOperator: a < b -> a >= b',
        'ConditionalExpression: a < b -> true',
        'ConditionalExpression: a < b -> false',
      ]),
    );
  });

  test('string concatenation is not arithmetic-mutated', () => {
    const { mutants } = instrument('a.js', 'x = "a" + b;');
    expect(mutants.filter((m) => m.mutator === 'ArithmeticOperator')).toEqual([]);
  });

  test('TS type positions are never mutated', () => {
    const src = 'type T = "a" | "b"; let x: T = "a" as const; function f(a: 1 | 2): "x" { return "x" as "x"; }';
    const { mutants } = instrument('a.ts', src);
    for (const m of mutants) {
      expect(m.original).not.toMatch(/^"(a|b|x)" \| /);
    }
    expect(summary(mutants)).toEqual(expect.arrayContaining(['StringLiteral: "a" -> ""', 'StringLiteral: "x" -> ""']));
    expect(mutants.some((m) => m.range.start < src.indexOf('let'))).toBe(false);
  });

  test('directives, imports and object keys are not mutated', () => {
    const src = '"use strict";\nimport x from "mod";\nconst o = { "k": 1, [`c`]: 2 };';
    const { mutants } = instrument('a.js', src);
    expect(mutants.map((m) => m.original)).not.toContain('"use strict"');
    expect(mutants.map((m) => m.original)).not.toContain('"mod"');
    expect(mutants.map((m) => m.original)).not.toContain('"k"');
  });

  test('ranges option restricts mutation', () => {
    const src = 'exports.a = 1 + 2;\nexports.b = 3 + 4;';
    const start = src.indexOf('3');
    const { mutants } = instrument('a.js', src, { ranges: [{ start, end: start + 5 }] });
    expect(mutants.map((m) => m.original)).toEqual(['3 + 4']);
  });

  test('excludedMutators', () => {
    const { mutants } = instrument('a.js', 'x = a + b;', { excludedMutators: ['ArithmeticOperator'] });
    expect(mutants).toEqual([]);
  });

  test('locations are 1-based lines', () => {
    const { mutants } = instrument('a.js', 'x = 1;\ny = a + b;');
    const m = mutants.find((m) => m.mutator === 'ArithmeticOperator')!;
    expect(m.location).toEqual({ start: { line: 2, column: 4 }, end: { line: 2, column: 9 } });
  });
});

// Behavioural oracle: running instrumented code with mutant k active must behave
// exactly like the source with only mutant k applied.
const corpus: Record<string, string> = {
  arithmetic: `exports.r = [1 + 2 * 3, 7 - 4 / 2, 9 % 4, -(1 + 1)];`,
  nested: `function f(a, b) { return (a + b) * (a - b) > 0 && a !== b; } exports.r = [f(3, 1), f(1, 3), f(2, 2)];`,
  logical: `const a = 0, b = 2; exports.r = [a || b, a && b, a ?? b, !a, !!b];`,
  conditional: `let n = 0; for (let i = 0; i < 3; i++) { if (i % 2 === 0) n += i; else n -= 1; } exports.r = n;`,
  whileLoop: `let i = 0, s = 0; while (i < 5) { s += i++; } exports.r = s;`,
  strings: "const name = 'x'; exports.r = [`hi ${name}`, '', 'abc', `plain`];",
  arrays: `exports.r = [[1, 2].length, [].length, new Array(3).length];`,
  objects: `exports.r = Object.keys({ a: 1, b: 2 }).length;`,
  block: `function g() { exports.side = 1; return 2; } exports.r = g();`,
  arrow: `const h = (x) => x * 2; exports.r = [h(2), h.name];`,
  fnName: `const named = function () { return 1 + 1; }; exports.r = named.name;`,
  methods: `exports.r = ['Ab'.toUpperCase(), ' a '.trim(), [3, 1].sort().join(), 'ab'.startsWith('a'), [1,2].some(x => x > 1)];`,
  optional: `const o = { a: { b: 1 } }; exports.r = [o?.a?.b, o.x?.y];`,
  update: `let c = 0; c++; ++c; c--; exports.r = c;`,
  assign: `let v = 10; v += 2; v *= 3; v -= 1; exports.r = v;`,
  unary: `const k = 3; exports.r = [-k, +k, ~k];`,
  booleans: `exports.r = [true, false, !true];`,
  asi: `let z = 1\nz = z + 1\n;[z].forEach((q) => { exports.r = q - 1 })`,
  thisBinding: `const obj = { v: 2, get() { return this.v + 1; } }; exports.r = obj.get();`,
  memberCall: `const arr = [1, 2, 3]; exports.r = arr.map((x) => x + 1).filter((x) => x > 2).length;`,
  label: `let t = 0; outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j > i) continue outer; t += 1; } } exports.r = t;`,
  switchCase: `function sw(x) { switch (x) { case 1: { const y = x + 1; return y; } default: return x - 1; } } exports.r = [sw(1), sw(5)];`,
  ternary: `const p = 3; exports.r = p > 2 ? 'big' : 'small';`,
  template: "const q = 2; exports.r = `${q + 1}-${q > 1}`;",
  classes: `class A { x = 1 + 1; static s = 'a'; m() { return this.x * 2; } } exports.r = [new A().m(), A.s];`,
  closures: `function mk() { let c = 0; return () => (c += 1); } const inc = mk(); inc(); exports.r = inc();`,
  defaultParam: `function d(a = 1 + 1) { return a; } exports.r = d();`,
  destructure: `const { a = 2 + 3 } = {}; const [b = 1 > 0] = []; exports.r = [a, b];`,
  comma: `let w = (1, 2 + 3); exports.r = w;`,
  inOperator: `exports.r = 'a' in { a: 1 } && !('b' in {});`,
  typeofDelete: `const dd = { x: 1 }; delete dd.x; exports.r = [typeof dd.x === 'undefined', Object.keys(dd).length];`,
  getterSetter: `const gs = { _v: 1, get v() { return this._v + 1; }, set v(n) { this._v = n * 2; } }; gs.v = 3; exports.r = gs.v;`,
  generators: `function* gen() { yield 1 + 1; yield 2 * 2; } exports.r = [...gen()];`,
  tagged: "const tag = (s, ...v) => s.raw.join('|') + v.join(); exports.r = tag`a${1 + 1}b`;",
  spreadCall: `const mx = Math.max(...[1, 2 + 3]); exports.r = mx;`,
  nullish: `let nn = null; nn ??= 4; let mm = 1; mm ||= 5; exports.r = [nn, mm];`,
  newExpr: `class P { constructor(a) { this.a = a > 1; } } exports.r = new P(2).a;`,
  parenChainCall: "const pc = { v: 7, m() { return this.v + 0; } }; exports.r = (pc?.m)();",
  parenChainTag: "const pt = { s: 'k', t(strs) { return this.s + strs.join('') + (1 + 1); } }; exports.r = (pt?.t)`x`;",
  parenDelete: "const pd = { a: { b: 1 }, c: 1 + 1 }; delete (pd?.a); exports.r = [JSON.stringify(pd), 'a' in pd];",
  parenAssign: "let pa = { x: 1 }; (pa.x) = 2 + 3; exports.r = pa.x;",
  regexLike: `exports.r = /a+/.test('aa') && 'x'.length === 1;`,
  regex: "const re = /^[a-c]+\\d{1,2}$/m; exports.r = [re.test('ab1'), re.test('x'), /\\s?\\w*/.exec(' a')[0], new RegExp('^b*', 'g').test('a'), RegExp('[^x]').test('x')];",
  callStatements: `const out = []; function add(v) { out.push(v); } add(1); add(2); out.sort(); [3].forEach((v) => { add(v); }); exports.r = out;`,
  infiniteFor: `let k = 0; for (;;) { k++; if (k > 2) break; } for (let j = 0; ; j++) { if (j === 1) { k += j; break; } } exports.r = k;`,
};

describe('mutation switching oracle', () => {
  for (const [name, src] of Object.entries(corpus)) {
    test(name, () => {
      const { code, mutants } = instrument(`${name}.js`, src);
      expect(evaluateIsolated(code, null)).toEqual(evaluateIsolated(src, null));
      const placed = mutants.filter((m) => !m.ignored);
      expect(placed.length).toBeGreaterThan(0);
      for (const m of placed) {
        const label = `${m.mutator} ${m.original} -> ${m.replacement}`;
        let expected: unknown;
        let expectedError = false;
        try {
          expected = evaluateIsolated(applyMutant(src, m), null);
        } catch {
          expectedError = true;
        }
        if (expectedError) {
          expect(() => evaluateIsolated(code, m.key), label).toThrow();
        } else {
          expect(evaluateIsolated(code, m.key), label).toEqual(expected);
        }
      }
    });
  }
});

describe('coverage counters', () => {
  test('records static hits when no test is running', () => {
    const { code, mutants } = instrument('a.js', 'exports.f = (a) => a + 1; exports.top = 2 * 3;');
    evaluate(code, null);
    const cov = (globalThis as any)[RUNTIME].cov.static as Record<string, number>;
    const top = mutants.find((m) => m.original === '2 * 3')!;
    const inner = mutants.find((m) => m.original === 'a + 1')!;
    expect(cov[top.key]).toBe(1);
    expect(cov[inner.key]).toBeUndefined();
  });

  test('records per-test hits', () => {
    const { code, mutants } = instrument('a.js', 'exports.f = (a) => a + 1;');
    const exp = evaluate(code, null) as { f: (n: number) => number };
    const rt = (globalThis as any)[RUNTIME];
    rt.testId = 't1';
    exp.f(1);
    rt.testId = null;
    expect(rt.cov.perTest.t1[mutants[0]!.key]).toBe(1);
  });

  test('hit limit aborts infinite loops', () => {
    const { code, mutants } = instrument('a.js', 'let i = 0; while (i < 3) { i++; }');
    const m = mutants.find((m) => m.replacement === 'i--')!;
    (globalThis as any)[RUNTIME] = { active: m.key, cov: { static: {}, perTest: {} }, testId: null, hits: 0, hitLimit: 100 };
    expect(() => new Function(code)()).toThrow(/hit limit/);
  });
});

describe('identity', () => {
  const base = `function add(a, b) {\n  return a + b;\n}\nfunction sub(a, b) {\n  return a - b;\n}\n`;
  const keysOf = (src: string, fn: string) =>
    instrument('m.js', src)
      .mutants.filter((m) => m.scope.id === fn)
      .map((m) => m.key)
      .sort();

  test('keys are stable across unrelated edits and line shifts', () => {
    const edited = `// header comment\n\n${base.replace('a - b', 'a - b - 1')}`;
    expect(keysOf(edited, 'add')).toEqual(keysOf(base, 'add'));
  });

  test('scope hash ignores comments and whitespace but tracks code', () => {
    const scopeHash = (src: string) => instrument('m.js', src).mutants.find((m) => m.scope.id === 'add')!.scope.hash;
    expect(scopeHash(base.replace('return a + b;', 'return a  +  b; // c'))).toBe(scopeHash(base));
    expect(scopeHash(base.replace('return a + b;', 'return a + b + 0;'))).not.toBe(scopeHash(base));
  });

  test('scope ids are position independent paths', () => {
    const src = `class K { m() { const inner = () => 1 + 1; return inner(); } }\nconst f = function () { return 2 * 2; };`;
    const ids = new Set(instrument('m.js', src).mutants.map((m) => m.scope.id));
    expect(ids).toEqual(new Set(['K.m', 'K.m>inner', 'f']));
  });

  test('keys are unique within a file', () => {
    const src = Object.values(corpus).join('\n');
    const { mutants } = instrument('all.js', src);
    expect(new Set(mutants.map((m) => m.key)).size).toBe(mutants.length);
  });
});

describe('output', () => {
  test('preserves formatting outside mutated regions and emits a sourcemap', () => {
    const src = 'const   spaced  =  1;\nexports.r = spaced + 1;\n';
    const { code, map } = instrument('a.js', src);
    expect(code).toContain('const   spaced  =  1;');
    expect(map.sources).toEqual(['a.js']);
    expect(map.mappings.length).toBeGreaterThan(0);
  });

  test('TS input stays TS (types are left for the downstream transformer)', () => {
    const src = 'export function f(a: number): number { return a + 1; }';
    const { code } = instrument('a.ts', src);
    expect(code).toContain('a: number');
  });

  test('keeps shebang first', () => {
    const { code } = instrument('a.js', '#!/usr/bin/env node\nx = 1 + 1;');
    expect(code.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  test('no mutants -> source unchanged', () => {
    const src = 'import x from "y";\nexport { x };\n';
    expect(instrument('a.js', src).code).toBe(src);
  });
});

describe('regressions', () => {
  test('method names on Object.prototype are not treated as mutators', () => {
    const { mutants } = instrument('a.js', 'x = n.toLocaleString("en"); y = o.toString();');
    expect(mutants.filter((m) => m.mutator === 'MethodExpression')).toEqual([]);
  });

  test('mixed ?? chains stay syntactically valid', () => {
    const { mutants } = instrument('a.js', 'x = a ?? b ?? c;');
    expect(summary(mutants)).toContain('LogicalOperator: a ?? b ?? c -> ((a ?? b) && c)');
  });

  test('ASI guard is only inserted at the outermost placement', () => {
    const { code } = instrument('a.js', 'let q = "x"\nq?.trim()');
    expect(code).not.toMatch(/\(;/);
  });
});

describe('identity option', () => {
  test('keys depend on the identity path, not on the file location', () => {
    const src = 'exports.f = (a, b) => a + b;';
    const a = instrument('/ci/checkout-1/src/m.js', src, { identity: 'src/m.js' }).mutants.map((m) => m.key);
    const b = instrument('/home/me/repo/src/m.js', src, { identity: 'src/m.js' }).mutants.map((m) => m.key);
    expect(a).toEqual(b);
    expect(instrument('/home/me/repo/src/m.js', src).mutants.map((m) => m.key)).not.toEqual(b);
  });
});
