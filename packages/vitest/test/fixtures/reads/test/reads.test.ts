import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { total } from '../src/parse.ts';

const root = join(import.meta.dirname, '..');
// Read at module load: counts for the file as well.
const data = JSON.parse(readFileSync(join(root, 'fixtures/data.json'), 'utf8')) as { values: number[] };

test('reads fixtures', async () => {
  expect(total(data.values)).toBe(6);
  expect(readdirSync(join(root, 'fixtures/cases'))).toEqual(['a.txt']);
  expect(existsSync(join(root, 'fixtures/missing.json'))).toBe(false);
  expect(statSync(join(root, 'src')).isDirectory()).toBe(true);
  expect(await readFile(join(root, 'fixtures/cases/a.txt'), 'utf8')).toBe('a\n');
  // The project root itself, and a recursive listing (keyed on every descendant).
  expect(readdirSync(root)).toContain('fixtures');
  expect(readdirSync(join(root, 'fixtures'), { recursive: true })).toContain('data.json');
  // Outside the project, under node_modules or .mutator: not recorded.
  readFileSync(createRequire(import.meta.url).resolve('vitest/package.json'));
  existsSync(join(root, 'node_modules/left-pad/package.json'));
  existsSync(join(root, '.mutator/snapshot.json'));
});

test('reads environment variables', () => {
  expect(process.env.MUTATOR_READS_FLAG ?? 'unset').toBeTypeOf('string');
  expect('MUTATOR_READS_OTHER' in process.env).toBeTypeOf('boolean');
  // Vitest's import.meta.env reads through process.env.
  expect(import.meta.env.MUTATOR_READS_META ?? 'unset').toBeTypeOf('string');
});
