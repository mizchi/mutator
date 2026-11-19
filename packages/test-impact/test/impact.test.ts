import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fixtureGit } from '../../cli/test/fixture-git.ts';
import * as sourceApi from '@mizchi/test-impact/source';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSourceCoverageMapper, selectAffectedTests } from '../src/index.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'test-impact-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

test('selects transitive runtime and type-only dependents separately, using tsconfig aliases', async () => {
  const root = project({
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@app/*': ['./src/*'] } } }),
    'src/a.ts': 'export const a = 1; export type A = number;',
    'src/barrel.ts': "export { a } from '@app/a';",
    'a.test.ts': "import('./src/barrel.js');",
    'types.test.ts': "import type { A } from '@app/a';",
    'other.spec.ts': 'export {};',
  });
  const result = await selectAffectedTests({ root, changes: { 'src/a.ts': [1] } });
  expect(result.files).toEqual(['a.test.ts']);
  expect(result.typecheckFiles).toEqual(['a.test.ts', 'types.test.ts']);
});

test('uses test-specific V8 observations while keeping unknown and incomplete cases', async () => {
  const root = project({
    'app.ts': 'export function a() { return 1 }\nexport function b() { return 2 }',
    'ui.spec.ts': 'export {};',
    'unknown.spec.ts': 'export {};',
  });
  const observations = { 'ui.spec.ts': {
    first: { scopes: ['app.ts#a'], complete: true },
    second: { scopes: ['app.ts#b'], complete: true },
    popup: { scopes: [], complete: false },
  } };
  const result = await selectAffectedTests({ root, changes: { 'app.ts': [1] }, observations });
  expect(result.matches.filter(m => m.test).map(m => m.test).sort()).toEqual(['first', 'popup']);
  expect(result.files).toEqual(['ui.spec.ts', 'unknown.spec.ts']);
  const added = await selectAffectedTests({ root, changes: { 'new.ts': null }, observations });
  expect(added.files).toEqual(['ui.spec.ts', 'unknown.spec.ts']);
});

test('computed imports remain candidates and a type-only unresolved import stays in the type graph', async () => {
  const root = project({
    'dynamic.test.ts': 'import(getTarget());',
    'typed.test.ts': "import type { A } from 'unresolved-alias';",
    'other.test.ts': 'export {};',
    'src/changed.ts': 'export const changed = true;',
  });
  const result = await selectAffectedTests({ root, changes: { 'src/changed.ts': null } });
  expect(result.files).toEqual(['dynamic.test.ts']);
  expect(result.typecheckFiles).toEqual(['dynamic.test.ts', 'typed.test.ts']);
});

test('resolves inline V8 source maps relative to a Node file URL and its sourceRoot', () => {
  const source = 'export function price() { return 10 }';
  const root = project({ 'src/price.ts': source });
  // Column 7 is the start of the function after 'export '.
  const map = { version: 3, sources: ['price.ts'], sourceRoot: '../src', sourcesContent: [source], names: [], mappings: 'OAAO' };
  const script = { url: pathToFileURL(join(root, 'dist/price.js')).href,
    source: source + '\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64'),
    functions: [{ functionName: 'price', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }],
  };
  expect(createSourceCoverageMapper({ root, targets: [join(root, 'src/price.ts')] })([script])).toEqual({ complete: true, scopes: ['src/price.ts#price'] });
});

test.each([
  'export function price() { return 1 } export const enabled = false;',
  'export const enabled = false; export function price() { return 1 }',
  'export const enabled = Boolean([1].map(function price() { return 1 }));',
])('keeps module-level dependents for a line shared with a function: %s', async source => {
  const root = project({
    'lib.ts': source,
    'flag.test.ts': "import {enabled} from './lib'; if (!enabled) throw Error();",
    'price.test.ts': 'export {};',
  });
  const result = await selectAffectedTests({ root, changes: { 'lib.ts': [1] }, observations: {
    'flag.test.ts': { flag: { scopes: [], complete: true } },
    'price.test.ts': { price: { scopes: ['lib.ts#price'], complete: true } },
  } });
  expect(result.files).toContain('flag.test.ts');
});

test('normalizes change paths, runner inventory, coverage files and scope paths', async () => {
  const root = project({
    'src/app.ts': 'export function price() {\n  return 1;\n}',
    'app.test.ts': "import './src/app';",
  });
  const common = { root, testFiles: ['./app.test.ts', 'app.test.ts'], changes: { './src/app.ts': [2] } };
  const result = await selectAffectedTests(common);
  expect(result.files).toEqual(['app.test.ts']);
  expect(result.typecheckFiles).toEqual(['app.test.ts']);
  const observed = await selectAffectedTests({ ...common, observations: {
    'test/../app.test.ts': { price: { scopes: ['./src/app.ts#price'], complete: true } },
    './app.test.ts': { unrelated: { scopes: [], complete: true } },
  } });
  expect(observed.matches).toEqual([{ file: 'app.test.ts', test: 'price', reason: 'executed src/app.ts#price' }]);
});

test.each([
  [{ complete: 'false', scopes: [] }, 'complete'],
  [{ complete: true, scopes: ['ok', 1] }, 'scopes'],
])('CLI rejects invalid coverage and identifies the affected file and test', (entry, field) => {
  const root = project({ 'coverage.json': JSON.stringify({ 'flag.test.ts': { checkout: entry } }) });
  fixtureGit(root, 'init', '-q');
  fixtureGit(root, 'commit', '--allow-empty', '-qm', 'base');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--root', root, '--since', 'HEAD', '--coverage', join(root, 'coverage.json')], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('flag.test.ts');
  expect(result.stderr).toContain('checkout');
  expect(result.stderr).toContain(field);
});

test('the source API exposes a predicate for transparent wrappers', () => {
  expect(sourceApi).not.toHaveProperty('TRANSPARENT');
  expect(sourceApi.isTransparent('TSAsExpression')).toBe(true);
  expect(sourceApi.isTransparent('Identifier')).toBe(false);
});
