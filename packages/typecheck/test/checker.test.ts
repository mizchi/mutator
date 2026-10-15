import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import * as ts6 from 'typescript6';
import * as ts7api from 'typescript7/unstable/sync';
import { createClassicChecker } from '../src/classic.ts';
import { createNativeChecker } from '../src/native.ts';
import type { TypeChecker, TypecheckMutant } from '../src/types.ts';

const ts7version: string = createRequire(import.meta.url)('typescript7/package.json').version;
const root = fileURLToPath(new URL('./fixtures/basic', import.meta.url));
const file = `${root}/src/a.ts`;
const source = readFileSync(file, 'utf8');

const replace = (key: string, original: string, replacement: string): TypecheckMutant => {
  const start = source.indexOf(original);
  return { key, file, range: { start, end: start + original.length }, replacement };
};

const backends: [string, (at?: string) => TypeChecker][] = [
  ['TypeScript 6 (compiler API)', (at = root) => createClassicChecker(ts6, { root: at, tsconfig: `${at}/tsconfig.json` })],
  ['TypeScript 7 (native API)', (at = root) => createNativeChecker(ts7api, { root: at, tsconfig: `${at}/tsconfig.json` }, ts7version)],
];

describe.each(backends)('%s', (_name, create) => {
  test('reports mutants that break types, ignoring pre-existing errors', () => {
    const checker = create();
    try {
      const result = checker.check([
        replace('ok-arith', 's.length', 's.length + 1'),
        replace('bad-return', '{\n  return s.length;\n}', '{\n  return "";\n}'),
        replace('ok-string', '`hello ${name}`', '``'),
        replace('bad-bool', '`hello ${name}`', 'true'),
      ]);
      expect([...result.keys()].sort()).toEqual(['bad-bool', 'bad-return']);
      expect(result.get('bad-return')).toMatch(/not assignable to type 'number'/);
    } finally {
      checker.close();
    }
  });

  test('checks are independent: a mutant is reverted before the next one', () => {
    const checker = create();
    try {
      const result = checker.check([replace('bad-return', '{\n  return s.length;\n}', '{\n  return "";\n}'), replace('ok-arith', 's.length', 's.length + 1')]);
      expect([...result.keys()]).toEqual(['bad-return']);
      expect(checker.check([replace('ok-arith', 's.length', 's.length - 1')]).size).toBe(0);
    } finally {
      checker.close();
    }
  });

  test('reports the TypeScript version', () => {
    const checker = create();
    try {
      expect(checker.version).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      checker.close();
    }
  });
});

const chainFile = `${root}/src/chain.ts`;
const chainSource = readFileSync(chainFile, 'utf8');

/** The OptionalChaining mutant on the `?.` inside the first `needle` (keyed by it). */
const unchain = (needle: string, at = chainFile, text = chainSource): TypecheckMutant => {
  const start = text.indexOf(needle) + needle.indexOf('?.');
  const computed = text[start + 2] === '(' || text[start + 2] === '[';
  return { key: needle, file: at, range: { start, end: start + 2 }, replacement: computed ? '' : '.' };
};

describe.each(backends)('%s: equivalent mutants', (_name, create) => {
  test('`a?.b` -> `a.b` is equivalent when the type of `a` excludes null and undefined', () => {
    const checker = create();
    try {
      const result = checker.equivalent([unchain('box?.value'), unchain('value?.name'), unchain('fn?.()'), unchain('run?.()'), unchain('box?.run()'), unchain('xs?.[k]')]);
      expect([...result.keys()]).toEqual(['box?.value', 'value?.name', 'fn?.()', 'run?.()', 'box?.run()', 'xs?.[k]']);
      expect(result.get('box?.value')).toBe('equivalent: box is never nullish');
      expect(result.get('value?.name')).toBe('equivalent: box?.value is never nullish');
    } finally {
      checker.close();
    }
  });

  test('nullable, any, unknown and type parameters prove nothing; neither does `??`', () => {
    const checker = create();
    try {
      const swap = (key: string, original: string, replacement: string): TypecheckMutant => {
        const start = chainSource.indexOf(original);
        return { key, file: chainFile, range: { start, end: start + original.length }, replacement };
      };
      const result = checker.equivalent([
        unchain('box?.maybe'),
        unchain('maybe?.name'),
        unchain('opt?.()'),
        unchain('x?.toString'),
        unchain('y?.name'),
        unchain(')?.a'),
        // The existing mutator turns `??` into `&&`: a different value whenever the left side is truthy.
        swap('a ??', "(a ?? 'x')", "(a && 'x')"),
      ]);
      expect([...result.keys()]).toEqual([]);
    } finally {
      checker.close();
    }
  });

  // Without noUncheckedIndexedAccess, `xs[0]` is typed `string` but is undefined for `[]`,
  // and the lie flows on through variables: types prove nothing there.
  test.each([
    ['without strictNullChecks', 'loose', ['box?.value']],
    ['without noUncheckedIndexedAccess', 'unchecked', ['box?.value', ']?.startsWith', 'head?.startsWith']],
  ])('nothing is proven %s', (_desc, fixture, needles) => {
    const at = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url));
    const atFile = `${at}/src/chain.ts`;
    const text = readFileSync(atFile, 'utf8');
    const checker = create(at);
    try {
      expect(checker.equivalent(needles.map((n) => unchain(n, atFile, text))).size).toBe(0);
    } finally {
      checker.close();
    }
  });

  test('type checking still works after the equivalence queries', () => {
    const checker = create();
    try {
      checker.equivalent([unchain('box?.value')]);
      expect([...checker.check([unchain('box?.maybe'), unchain('box?.value')]).keys()]).toEqual(['box?.maybe']);
    } finally {
      checker.close();
    }
  });
});
