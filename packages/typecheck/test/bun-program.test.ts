import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { inImportCycle, includeBase, parseExplainFiles, readProgram } from '../src/bun-program.ts';

/** A path of the project at /p, spelled as this platform resolves it. */
const at = (file: string) => resolve('/p', file);

// Shaped like `bun check --listFilesOnly --explainFiles`: files unindented, the reasons below each.
const output = [
  'tsconfig.json(1,39): error TS6053: File \'missing-pkg\' not found.',
  '::error file=tsconfig.json,line=1,col=39,title=TS6053::File \'missing-pkg\' not found.',
  'bundled:///libs/lib.es5.d.ts',
  '   Default library for target \'ES2025\'',
  'src/a.ts',
  '   Matched by include pattern \'src\' in \'tsconfig.json\'',
  '   Imported via "./a" from file \'src/b.ts\'',
  'src/b.ts',
  '   Imported via \'./b.ts\' from file \'src/a.ts\'',
  'src/types.d.ts',
  '   Referenced via \'./types.d.ts\' from file \'src/c.ts\'',
  'src/c.ts',
  '   Matched by include pattern \'src\' in \'tsconfig.json\'',
  '',
].join('\n');

describe('parseExplainFiles', () => {
  test('lists the files without bundled libs or diagnostics, and who imports which, from the working directory', () => {
    const { files, imports } = parseExplainFiles(output, '/p');
    expect(files).toEqual(['src/a.ts', 'src/b.ts', 'src/types.d.ts', 'src/c.ts'].map(at));
    expect([...imports]).toEqual([
      [at('src/b.ts'), [at('src/a.ts')]],
      [at('src/a.ts'), [at('src/b.ts')]],
      [at('src/c.ts'), [at('src/types.d.ts')]],
    ]);
  });

  test('reads Windows line endings too', () => {
    expect(parseExplainFiles(output.replaceAll('\n', '\r\n'), '/p')).toEqual(parseExplainFiles(output, '/p'));
  });
});

describe('readProgram', () => {
  test('a listing that fails is an error, not a program without imports', () => {
    // Run from Node, process.execPath is not Bun, so the listing fails.
    const tsconfig = join(fileURLToPath(new URL('./fixtures/basic', import.meta.url)), 'tsconfig.json');
    expect(() => readProgram(tsconfig)).toThrow(/^bun check --explainFiles failed/);
  });
});

describe('includeBase', () => {
  const from = resolve('/p/config');
  const noFiles = () => false;
  test.each([
    ['a wildcard first', '**/*', from],
    ['a relative prefix', '../src/**/*.ts', resolve('/p/src')],
    ['an absolute prefix', '/abs/src/**/*.ts', resolve('/abs/src')],
    ['a wildcard right after the root', '/*/src/**/*.ts', resolve('/')],
    ['a directory', 'src', resolve(from, 'src')],
    ['a source file not created yet', '../types/globals.d.ts', resolve('/p/types')],
  ])('%s', (_name, pattern, base) => {
    expect(includeBase(pattern, from, noFiles)).toBe(base);
  });

  test('an existing file without a source extension', () => {
    expect(includeBase('../data/list', from, (path) => path === resolve('/p/data/list'))).toBe(resolve('/p/data'));
  });

  test.runIf(process.platform === 'win32')('a wildcard right after a drive', () => {
    expect(includeBase('C:\\*\\src\\**\\*.ts', 'C:\\p\\config', noFiles)).toBe('C:\\');
  });
});

describe('inImportCycle', () => {
  const { imports } = parseExplainFiles(output, '/p');
  test('a file its imports lead back to', () => {
    expect(inImportCycle(at('src/a.ts'), imports)).toBe(true);
    expect(inImportCycle(at('src/b.ts'), imports)).toBe(true);
  });
  test('a file they do not', () => {
    expect(inImportCycle(at('src/c.ts'), imports)).toBe(false);
    expect(inImportCycle(at('src/types.d.ts'), imports)).toBe(false);
  });
});
