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
const tsconfig = `${root}/tsconfig.json`;
const file = `${root}/src/a.ts`;
const source = readFileSync(file, 'utf8');

const replace = (key: string, original: string, replacement: string): TypecheckMutant => {
  const start = source.indexOf(original);
  return { key, file, range: { start, end: start + original.length }, replacement };
};

const backends: [string, () => TypeChecker][] = [
  ['TypeScript 6 (compiler API)', () => createClassicChecker(ts6, { root, tsconfig })],
  ['TypeScript 7 (native API)', () => createNativeChecker(ts7api, { root, tsconfig }, ts7version)],
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
