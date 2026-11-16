import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { typeInputHash } from '../src/typecheck-cache.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('adding an ambient declaration invalidates compiler discovery inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-types-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(fileURLToPath(new URL('../../typecheck/node_modules/typescript6', import.meta.url)), join(root, 'node_modules/typescript'), 'dir');
  const inputs = { files: [], directories: [], searches: [{ directory: 'src', extensions: ['.ts'], excludes: [], includes: ['**/*'] }] };
  const before = typeInputHash(root, inputs);
  expect(before).toBeTypeOf('string');
  writeFileSync(join(root, 'src/global.d.ts'), 'declare const version: number;');
  expect(typeInputHash(root, inputs)).not.toBe(before);
});

test('newly resolvable imports invalidate previously missing file inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-types-'));
  roots.push(root);
  const inputs = { files: ['missing.d.ts'], directories: [], searches: [] };
  const before = typeInputHash(root, inputs);
  writeFileSync(join(root, 'missing.d.ts'), 'export type Value = string;');
  expect(typeInputHash(root, inputs)).not.toBe(before);
});

test('compiler searches respect explicit node_modules includes and exclusions', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-types-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules/custom'), { recursive: true });
  symlinkSync(fileURLToPath(new URL('../../typecheck/node_modules/typescript6', import.meta.url)), join(root, 'node_modules/typescript'), 'dir');
  const inputs = { files: [], directories: [], searches: [{ directory: '.', extensions: ['.ts'], excludes: [], includes: ['node_modules/custom/**/*.ts'] }] };
  const before = typeInputHash(root, inputs);
  expect(before).toBeTypeOf('string');
  writeFileSync(join(root, 'node_modules/custom/global.d.ts'), 'declare const version: number;');
  const after = typeInputHash(root, inputs);
  expect(after).not.toBe(before);
  writeFileSync(join(root, 'unrelated.d.ts'), 'declare const other: number;');
  expect(typeInputHash(root, inputs)).toBe(after);
});
