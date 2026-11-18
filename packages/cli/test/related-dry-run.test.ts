import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runMutation } from '../src/run.ts';

let root: string;
beforeEach(() => {
  const parent = fileURLToPath(new URL('../../../.tmp', import.meta.url));
  mkdirSync(parent, { recursive: true });
  root = mkdtempSync(join(parent, 'related-dry-'));
  for (const dir of ['src', 'test', 'test/helpers']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'vitest.config.ts'), "export default { test: { include: ['test/**/*.test.ts'] } };\n");
  writeFileSync(join(root, 'src/a.ts'), 'export const a = (n: number) => n + 1;\n');
  writeFileSync(join(root, 'src/b.ts'), 'export const b = (n: number) => n * 2;\n');
  writeFileSync(join(root, 'test/helpers/a.ts'), "export { a } from '../../src/a.ts';\n");
  writeFileSync(join(root, 'test/a.test.ts'), "import { test, expect } from 'vitest';\nimport { a } from './helpers/a.ts';\ntest('a', () => expect(a(2)).toBe(3));\n");
  writeFileSync(join(root, 'test/b.test.ts'), "import { test, expect } from 'vitest';\nimport { b } from '../src/b.ts';\ntest('b', () => expect(b(2)).toBe(4));\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const file = (name: string) => join('test', `${name}.test.ts`);

test('the first run of each include set runs only importing tests, including re-exports', async () => {
  const marker = join(root, 'b-ran');
  writeFileSync(join(root, 'test/b.test.ts'), "import { test, expect } from 'vitest';\nimport { writeFileSync } from 'node:fs';\nimport { b } from '../src/b.ts';\ntest('b', () => { writeFileSync(new URL('../b-ran', import.meta.url), 'ran'); expect(b(2)).toBe(4); });\n");
  for (const name of ['a', 'b']) {
    const report = await runMutation({ root, include: [`src/${name}.ts`], typecheck: false });
    expect(report.dryRunFiles).toEqual([file(name)]);
    expect(report.entries.some((e) => e.status === 'Killed')).toBe(true);
    expect(existsSync(marker)).toBe(name === 'b');
    expect((await runMutation({ root, include: [`src/${name}.ts`], typecheck: false })).dryRunFiles).toEqual([]);
  }
});

test('a literal dynamic import participates in the dependency graph', async () => {
  writeFileSync(join(root, 'test/a.test.ts'), "import { test, expect } from 'vitest';\ntest('a', async () => { const { a } = await import('../src/a.ts'); expect(a(2)).toBe(3); });\n");
  const report = await runMutation({ root, include: ['src/a.ts'], typecheck: false });
  expect(report.dryRunFiles).toEqual([file('a')]);
  expect(report.entries.some((e) => e.status === 'Killed')).toBe(true);
});

test('full-dry-run still runs every discovered test file', async () => {
  const report = await runMutation({ root, include: ['src/a.ts'], typecheck: false, fullDryRun: true });
  expect(report.dryRunFiles?.sort()).toEqual([file('a'), file('b')].sort());
});

test('a computed import falls back to all tests instead of inventing NoCoverage', async () => {
  writeFileSync(join(root, 'test/a.test.ts'), "import { test, expect } from 'vitest';\nconst name = '../src/a.ts';\ntest('a', async () => { const { a } = await import(/* @vite-ignore */ name); expect(a(2)).toBe(3); });\n");
  const report = await runMutation({ root, include: ['src/a.ts'], typecheck: false });
  expect(report.dryRunFiles?.sort()).toEqual([file('a'), file('b')].sort());
  expect(report.noCoverage).toBeUndefined();
  expect(report.entries.some((e) => e.status === 'Killed')).toBe(true);
});

test('a computed import in a transitive helper also falls back to all tests', async () => {
  writeFileSync(join(root, 'test/helpers/a.ts'), "export async function a(n: number) { const name = '../../src/a.ts'; const mod = await import(/* @vite-ignore */ name); return mod.a(n); }\n");
  writeFileSync(join(root, 'test/a.test.ts'), "import { test, expect } from 'vitest';\nimport { a } from './helpers/a.ts';\ntest('a', async () => expect(await a(2)).toBe(3));\n");
  const report = await runMutation({ root, include: ['src/a.ts'], typecheck: false });
  expect(report.dryRunFiles?.sort()).toEqual([file('a'), file('b')].sort());
  expect(report.entries.some((e) => e.status === 'Killed')).toBe(true);
});
