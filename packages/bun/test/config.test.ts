import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { listTestFiles, readBunfig, tomlValues } from '../src/config.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mutator-bun-config-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
};

test('tomlValues reads string and array entries by table', () => {
  const values = tomlValues(`# comment
preload = "./global.ts" # trailing
[test]
root = 'tests'
preload = [
  "./setup.ts", # one
  "./with#hash.ts",
]
coverage = true
[install]
registry = "https://example.com"
`);
  expect(values.get('preload')).toEqual(['./global.ts']);
  expect(values.get('test.root')).toEqual(['tests']);
  expect(values.get('test.preload')).toEqual(['./setup.ts', './with#hash.ts']);
  expect(values.get('test.coverage')).toEqual([]);
  expect(values.get('install.registry')).toEqual(['https://example.com']);
});

test('readBunfig resolves the test root and preload files; package preloads are not project files', () => {
  write({ 'bunfig.toml': '[test]\nroot = "./spec"\npreload = ["./setup.ts", "happy-dom/global"]\n' });
  expect(readBunfig(root)).toEqual({ path: join(root, 'bunfig.toml'), testRoot: join(root, 'spec'), preload: [join(root, 'setup.ts')] });
});

test('readBunfig without a bunfig.toml, and with an explicit one', () => {
  expect(readBunfig(root)).toEqual({ path: undefined, testRoot: undefined, preload: [] });
  write({ 'config/ci.toml': 'preload = "./ci-setup.ts"\n' });
  expect(readBunfig(root, 'config/ci.toml')).toEqual({ path: join(root, 'config/ci.toml'), testRoot: undefined, preload: [join(root, 'config/ci-setup.ts')] });
  expect(() => readBunfig(root, 'missing.toml')).toThrow('does not exist');
});

test("listTestFiles follows bun test's naming rules", () => {
  const files = ['a/x.test.ts', 'a/x.test.mts', 'a/x.test.tsx', 'a/x.test.cjs', 'a/y_test.js', 'a/z.spec.jsx', 'a/w_spec.mjs', 'dist/d.test.js'];
  const ignored = ['node_modules/p/n.test.ts', '.hidden/h.test.ts', 'a/q.tests.ts', 'a/r-test.ts', 'a/x.test.json', 'a/plain.ts'];
  write(Object.fromEntries([...files, ...ignored].map((f) => [f, ''])));
  expect(listTestFiles(root)).toEqual(files.map((f) => join(root, f)).sort());
});
