import { join, resolve, sep } from 'node:path';
import { expect, test } from 'vitest';
import { relativePath } from '../src/index.ts';

test('relative path keys use forward slashes on every host', () => {
  const root = resolve('project');
  expect(relativePath(root, join(root, 'src', 'nested', 'file.ts'))).toBe('src/nested/file.ts');
  expect(relativePath(root, join(root, '..', 'shared', 'file.ts'))).toBe('../shared/file.ts');
  expect(relativePath(root, root)).toBe('');
});

test('POSIX filenames containing a literal backslash retain that character', () => {
  const root = resolve('project');
  expect(relativePath(root, join(root, 'a\\b.ts'))).toBe(sep === '/' ? 'a\\b.ts' : 'a/b.ts');
});
