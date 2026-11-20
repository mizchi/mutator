import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import * as ts6 from 'typescript6';
import * as ts7api from 'typescript7/unstable/sync';
import { bunTypescriptVersion, createBunChecker } from '../src/bun.ts';
import { createClassicChecker } from '../src/classic.ts';
import { createNativeChecker } from '../src/native.ts';
import type { TypeChecker, TypecheckMutant } from '../src/types.ts';

const ts7version: string = createRequire(import.meta.url)('typescript7/package.json').version;
const root = fileURLToPath(new URL('./fixtures/basic', import.meta.url));
const file = join(root, 'src', 'a.ts');
const source = readFileSync(file, 'utf8');
const chainFile = `${root}/src/chain.ts`;
const chainSource = readFileSync(chainFile, 'utf8');

/** The mutant replacing the first `original` in `text` (the source of `at`). */
const replace = (key: string, original: string, replacement: string, at = file, text = source): TypecheckMutant => {
  const start = text.indexOf(original);
  return { key, file: at, range: { start, end: start + original.length }, replacement };
};

const backends: [string, (at?: string) => TypeChecker][] = [
  ['TypeScript 6 (compiler API)', (at = root) => createClassicChecker(ts6, { root: at, tsconfig: join(at, 'tsconfig.json') })],
  ['TypeScript 7 (native API)', (at = root) => createNativeChecker(ts7api, { root: at, tsconfig: join(at, 'tsconfig.json') }, ts7version)],
];
// Bun's checker proves no equivalences, so it only joins the type-error tests.
// Only a missing Bun (or one without its checker) skips the Bun tests.
const bunVersion = bunTypescriptVersion(root) ?? '';
const checkers: typeof backends = [
  ...backends,
  ...(bunVersion ? [['Bun (bun check)', (at = root) => createBunChecker({ root: at, tsconfig: join(at, 'tsconfig.json') }, bunVersion)] as (typeof backends)[number]] : []),
];

describe.each(checkers)('%s', (_name, create) => {
  test('canonicalizes the virtual file path before applying and reverting overrides', () => {
    const checker = create();
    try {
      const mutant = { ...replace('alias-bool', '`hello ${name}`', 'true'), file: `${root}/src/./a.ts` };
      expect([...checker.check([mutant]).keys()]).toEqual(['alias-bool']);
      expect(checker.check([replace('after-alias', 's.length', 's.length + 1')]).size).toBe(0);
    } finally { checker.close(); }
  });
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

  test('a mutant that does not parse fails, and hides the type errors of no other mutant', () => {
    const checker = create();
    try {
      const result = checker.check([
        replace('syntax', 's.length', 's.length +'),
        replace('bad-return', '{\n  return s.length;\n}', '{\n  return "";\n}'),
        replace('chain-bad', 'box?.value?.name', '1', chainFile, chainSource),
        replace('ok-arith', 's.length', 's.length + 1'),
      ]);
      expect([...result.keys()].sort()).toEqual(['bad-return', 'chain-bad', 'syntax']);
    } finally {
      checker.close();
    }
  });

  test('finds a type error that comes back through an import cycle', () => {
    const checker = create();
    try {
      const cycleFile = join(root, 'src', 'cycle.ts');
      const cycleSource = readFileSync(cycleFile, 'utf8');
      const result = checker.check([
        replace('cycle-bad', 'return 1;', 'return "x";', cycleFile, cycleSource),
        replace('cycle-ok', 'return 1;', 'return 2;', cycleFile, cycleSource),
        replace('cycle-syntax', 'return 1;', 'return 1 +;', cycleFile, cycleSource),
        replace('a-bad', '`hello ${name}`', 'true'),
      ]);
      expect([...result.keys()].sort()).toEqual(['a-bad', 'cycle-bad', 'cycle-syntax']);
    } finally {
      checker.close();
    }
  });

  test('follows a cycle of type imports: types derived from the mutant are no error', () => {
    const checker = create();
    try {
      const kindsFile = join(root, 'src', 'kinds.ts');
      const kindsSource = readFileSync(kindsFile, 'utf8');
      const result = checker.check([
        replace('kinds-ok', "'a', 'b'", "'c', 'b'", kindsFile, kindsSource),
        replace('kinds-bad', 'KINDS[0]', "'z'", kindsFile, kindsSource),
      ]);
      expect([...result.keys()]).toEqual(['kinds-bad']);
    } finally {
      checker.close();
    }
  });

  test('checks mutants of several files in one call, each against its own file', () => {
    const checker = create();
    try {
      const result = checker.check([
        replace('a-bad', '`hello ${name}`', 'true'),
        replace('chain-bad', 'box?.value?.name', '1', chainFile, chainSource),
        replace('a-ok', 's.length', 's.length + 1'),
        replace('chain-ok', "'y'", "''", chainFile, chainSource),
      ]);
      expect([...result.keys()].sort()).toEqual(['a-bad', 'chain-bad']);
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

  test('records type inputs, including imported declarations and configuration', () => {
    const checker = create();
    try {
      checker.equivalent([replace('type-input', 's.length', 's.length + 1')]);
      checker.check([replace('type-input', 's.length', 's.length + 1')]);
      expect(checker.inputs.files).toContain(file);
      expect(checker.inputs.files).toContain(join(root, 'tsconfig.json'));
    } finally { checker.close(); }
  });
});

/** The OptionalChaining mutant on the `?.` inside the first `needle` (keyed by it). */
const unchain = (needle: string, at = chainFile, text = chainSource): TypecheckMutant => {
  const start = text.indexOf(needle) + needle.indexOf('?.');
  const computed = text[start + 2] === '(' || text[start + 2] === '[';
  return { key: needle, file: at, range: { start, end: start + 2 }, replacement: computed ? '' : '.' };
};

describe.skipIf(!bunVersion)('Bun (bun check) with a tsconfig other than the root one', () => {
  // tsconfig.loose.json extends tsconfig.json, turning strict off.
  const loose = join(root, 'tsconfig.loose.json');

  test('checks with that tsconfig', () => {
    const mutant = replace('undefined-return', 's.length', 'undefined');
    expect([...createBunChecker({ root, tsconfig: join(root, 'tsconfig.json') }, bunVersion).check([mutant]).keys()]).toEqual(['undefined-return']);
    expect(createBunChecker({ root, tsconfig: loose }, bunVersion).check([mutant]).size).toBe(0);
  });

  test('records the tsconfig and every file it extends as inputs', () => {
    const checker = createBunChecker({ root, tsconfig: loose }, bunVersion);
    expect(checker.inputs.files).toEqual(expect.arrayContaining([loose, join(root, 'tsconfig.json'), file]));
  });

  test('takes the configuration a package names in `tsconfig`, else its tsconfig.json, never its main', () => {
    const at = mkdtempSync(join(tmpdir(), 'tc-bun-extends-'));
    try {
      cpSync(root, at, { recursive: true });
      const packages = [
        ['with-config', {}, { 'tsconfig.json': '{}' }],
        ['with-field', { tsconfig: './configs/base.json' }, { 'tsconfig.json': '{}', 'configs/base.json': '{}' }],
        ['with-main', {}, { 'index.js': 'export {};' }],
      ] as const;
      for (const [name, manifest, files] of packages) {
        mkdirSync(join(at, 'node_modules', name, 'configs'), { recursive: true });
        writeFileSync(join(at, 'node_modules', name, 'package.json'), JSON.stringify({ name, main: 'index.js', ...manifest }));
        for (const [fileName, text] of Object.entries(files)) writeFileSync(join(at, 'node_modules', name, fileName), text);
      }
      const tsconfig = join(at, 'tsconfig.packages.json');
      writeFileSync(tsconfig, JSON.stringify({ extends: ['with-config', 'with-field', 'with-main', './tsconfig.json'] }));
      const { files } = createBunChecker({ root: at, tsconfig }, bunVersion).inputs;
      // A package's file is where Bun's resolver finds it, symlinks followed.
      const inPackage = (...path: string[]) => realpathSync(join(at, 'node_modules', ...path));
      expect(files).toEqual(expect.arrayContaining([tsconfig, inPackage('with-config', 'tsconfig.json'), inPackage('with-field', 'configs', 'base.json'), join(at, 'tsconfig.json')]));
      // Its `tsconfig` field chose the configuration, so editing it must invalidate cached verdicts.
      expect(files).toContain(inPackage('with-field', 'package.json'));
      expect(files.filter((path) => path.endsWith('index.js') || path === inPackage('with-field', 'tsconfig.json') || !isAbsolute(path))).toEqual([]);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });

  test('records the directories where an included file may appear, even empty ones', () => {
    const at = mkdtempSync(join(tmpdir(), 'tc-bun-dirs-'));
    try {
      cpSync(root, at, { recursive: true });
      mkdirSync(join(at, 'src', 'extra'));
      mkdirSync(join(at, 'node_modules', 'dep'), { recursive: true });
      const { directories } = createBunChecker({ root: at, tsconfig: join(at, 'tsconfig.json') }, bunVersion).inputs;
      // The fixture's tsconfig includes `src`.
      expect(directories).toEqual(expect.arrayContaining([join(at, 'src'), join(at, 'src', 'extra')]));
      expect(directories.filter((path) => path.includes('node_modules'))).toEqual([]);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  });

  test('follows `include` out of the tsconfig\'s directory, and lists past an unreadable directory', () => {
    const at = mkdtempSync(join(tmpdir(), 'tc-bun-include-'));
    try {
      cpSync(root, at, { recursive: true });
      mkdirSync(join(at, 'src', 'extra'));
      mkdirSync(join(at, 'src', 'private'));
      chmodSync(join(at, 'src', 'private'), 0o000);
      mkdirSync(join(at, 'config'));
      const tsconfig = join(at, 'config', 'tsconfig.json');
      writeFileSync(tsconfig, JSON.stringify({ extends: '../tsconfig.json', include: ['../src/**/*.ts'] }));
      const { directories } = createBunChecker({ root: at, tsconfig }, bunVersion).inputs;
      expect(directories).toEqual(expect.arrayContaining([join(at, 'src'), join(at, 'src', 'extra'), join(at, 'src', 'private')]));
    } finally {
      chmodSync(join(at, 'src', 'private'), 0o755);
      rmSync(at, { recursive: true, force: true });
    }
  });
});

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
      const result = checker.equivalent([
        unchain('box?.maybe'),
        unchain('maybe?.name'),
        unchain('opt?.()'),
        unchain('x?.toString'),
        unchain('y?.name'),
        unchain(')?.a'),
        // The existing mutator turns `??` into `&&`: a different value whenever the left side is truthy.
        replace('a ??', "(a ?? 'x')", "(a && 'x')", chainFile, chainSource),
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
