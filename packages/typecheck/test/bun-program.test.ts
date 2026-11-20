import { describe, expect, test } from 'vitest';
import { inImportCycle, parseExplainFiles } from '../src/bun-program.ts';

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
    expect(files).toEqual(['/p/src/a.ts', '/p/src/b.ts', '/p/src/types.d.ts', '/p/src/c.ts']);
    expect(Object.fromEntries(imports)).toEqual({
      '/p/src/b.ts': ['/p/src/a.ts'],
      '/p/src/a.ts': ['/p/src/b.ts'],
      '/p/src/c.ts': ['/p/src/types.d.ts'],
    });
  });
});

describe('inImportCycle', () => {
  const { imports } = parseExplainFiles(output, '/p');
  test('a file its imports lead back to', () => {
    expect(inImportCycle('/p/src/a.ts', imports)).toBe(true);
    expect(inImportCycle('/p/src/b.ts', imports)).toBe(true);
  });
  test('a file they do not', () => {
    expect(inImportCycle('/p/src/c.ts', imports)).toBe(false);
    expect(inImportCycle('/p/src/types.d.ts', imports)).toBe(false);
  });
});
