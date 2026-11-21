import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTypeChecker } from '@mizchi/mutator-typecheck';
import { afterEach, expect, test } from 'vitest';
import { portableTypeInputs, typeInputHash } from '../src/typecheck-cache.ts';

// Only a missing Bun skips; one that fails to start fails the tests.
const hasBun = (spawnSync('bun', ['--version']).error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('adding an ambient declaration invalidates compiler discovery inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-types-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(fileURLToPath(new URL('../../typecheck/node_modules/typescript6', import.meta.url)), join(root, 'node_modules/typescript'), 'dir');
  const inputs = { files: [], directories: [], directoryChecks: [], searches: [{ directory: 'src', extensions: ['.ts'], excludes: [], includes: ['**/*'] }] };
  const before = typeInputHash(root, inputs);
  expect(before).toBeTypeOf('string');
  writeFileSync(join(root, 'src/global.d.ts'), 'declare const version: number;');
  expect(typeInputHash(root, inputs)).not.toBe(before);
});

test('newly resolvable imports invalidate previously missing file inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-types-'));
  roots.push(root);
  const inputs = { files: ['missing.d.ts'], directories: [], directoryChecks: [], searches: [] };
  const before = typeInputHash(root, inputs);
  writeFileSync(join(root, 'missing.d.ts'), 'export type Value = string;');
  expect(typeInputHash(root, inputs)).not.toBe(before);
});

test('compiler searches respect explicit node_modules includes and exclusions', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-types-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules/custom'), { recursive: true });
  symlinkSync(fileURLToPath(new URL('../../typecheck/node_modules/typescript6', import.meta.url)), join(root, 'node_modules/typescript'), 'dir');
  const inputs = { files: [], directories: [], directoryChecks: [], searches: [{ directory: '.', extensions: ['.ts'], excludes: [], includes: ['node_modules/custom/**/*.ts'] }] };
  const before = typeInputHash(root, inputs);
  expect(before).toBeTypeOf('string');
  writeFileSync(join(root, 'node_modules/custom/global.d.ts'), 'declare const version: number;');
  const after = typeInputHash(root, inputs);
  expect(after).not.toBe(before);
  writeFileSync(join(root, 'unrelated.d.ts'), 'declare const other: number;');
  expect(typeInputHash(root, inputs)).toBe(after);
});

test('existence probes ignore entry changes but notice a directory disappearing', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-types-'));
  roots.push(root);
  mkdirSync(join(root, 'resolution'));
  const inputs = { files: [], directories: [], directoryChecks: ['resolution'], searches: [] };
  const before = typeInputHash(root, inputs);
  writeFileSync(join(root, 'resolution/unrelated.ts'), 'export const unrelated = 1;');
  expect(typeInputHash(root, inputs)).toBe(before);
  rmSync(join(root, 'resolution'), { recursive: true });
  expect(typeInputHash(root, inputs)).not.toBe(before);
});

test('enumerated directories still invalidate when entries change', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-types-'));
  roots.push(root);
  const inputs = { files: [], directories: ['.'], directoryChecks: [], searches: [] };
  const before = typeInputHash(root, inputs);
  writeFileSync(join(root, 'new.d.ts'), 'declare const version: number;');
  expect(typeInputHash(root, inputs)).not.toBe(before);
});

// Bun's checker (no `typescript` resolves from tmpdir) records where its tsconfig's `include` can
// match: a file added there, in a directory that held no program file, invalidates the verdicts.
test.skipIf(!hasBun).each([
  ['an absolute pattern', (root: string) => [`${root}/src/**/*.ts`], 'src/extra/decl.d.ts'],
  ['a file not created yet', () => ['../types/globals.d.ts', '../src/**/*.ts'], 'types/globals.d.ts'],
] as const)('Bun-checked verdicts are invalidated by a file added through %s', async (_name, include, added) => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-bun-include-'));
  roots.push(root);
  for (const dir of ['config', 'src/extra', 'types']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export const a: number = 1;\n');
  const tsconfig = join(root, 'config/tsconfig.json');
  writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: include(root) }));
  const checker = await createTypeChecker({ root, tsconfig });
  expect(checker?.version).toMatch(/via bun check$/);
  const inputs = portableTypeInputs(root, [checker!.inputs]);
  checker!.close();
  const before = typeInputHash(root, inputs);
  expect(before).toBeTypeOf('string');
  writeFileSync(join(root, added), 'declare const version: number;\n');
  expect(typeInputHash(root, inputs)).not.toBe(before);
});
