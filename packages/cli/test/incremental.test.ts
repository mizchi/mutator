// Edit sequences found by review: an incremental run must give the same verdicts as a cold run.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { BaselineError, type Report, runMutation } from '../src/run.ts';

const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));
const CONFIG = `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n`;
const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = join(tmpRoot, `inc-${process.pid}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  for (const [file, content] of Object.entries({ 'vitest.config.ts': CONFIG, ...files })) write(root, file, content);
  return root;
}

function write(root: string, file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

const edit = (root: string, file: string, from: string, to: string) => write(root, file, readFileSync(join(root, file), 'utf8').replace(from, to));

const verdicts = (r: Report) =>
  r.entries.map((e) => `${e.mutant.scope.id} ${e.mutant.original} -> ${e.mutant.replacement} = ${e.status}`.replace(/\s+/g, ' ')).sort();

async function expectSameAsCold(root: string): Promise<Report> {
  const incremental = await runMutation({ root, concurrency: 1 });
  const cold = await runMutation({ root, concurrency: 1, snapshotPath: join(root, '.mutator/cold.json') });
  expect(verdicts(incremental)).toEqual(verdicts(cold));
  return incremental;
}

describe('incremental runs match cold runs', { timeout: 60_000 }, () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('editing a top-level constant without mutants', async () => {
    const root = project({
      'src/a.ts': 'const LIMIT = 10;\nexport function clamp(n: number): number {\n  return n > LIMIT ? -1 : n;\n}\n',
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { clamp } from '../src/a.ts';\ntest('clamp', () => { expect(clamp(5)).toBe(5); expect(clamp(100)).toBe(-1); });\n",
    });
    await runMutation({ root, concurrency: 1 });
    edit(root, 'src/a.ts', 'LIMIT = 10', 'LIMIT = 5');
    const report = await expectSameAsCold(root);
    expect(report.dryRunFiles).toEqual(['test/a.test.ts']);
  });

  test('an edit outside any mutant that breaks a test still fails the baseline', async () => {
    const root = project({
      'src/a.ts': 'const LIMIT = 10;\nexport function clamp(n: number): number {\n  return n > LIMIT ? -1 : n;\n}\n',
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { clamp } from '../src/a.ts';\ntest('clamp', () => { expect(clamp(7)).toBe(7); });\n",
    });
    await runMutation({ root, concurrency: 1 });
    edit(root, 'src/a.ts', 'LIMIT = 10', 'LIMIT = 5');
    await expect(runMutation({ root, concurrency: 1 })).rejects.toBeInstanceOf(BaselineError);
  });

  test('a setup file edit is seen', async () => {
    const root = project({
      'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'], setupFiles: ['./setup.ts'] } });\n",
      'setup.ts': '(globalThis as any).FACTOR = 1;\n',
      'src/a.ts': 'export function scale(n: number): number {\n  return n * (globalThis as any).FACTOR;\n}\n',
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { scale } from '../src/a.ts';\ntest('scale', () => { expect(scale(3)).toBe(3); });\n",
    });
    await runMutation({ root, concurrency: 1 });
    write(root, 'setup.ts', '(globalThis as any).FACTOR = 2;\n');
    await expect(runMutation({ root, concurrency: 1 })).rejects.toBeInstanceOf(BaselineError);
  });

  test('coverage of reused results follows new tests', async () => {
    const t = (name: string) =>
      `import { expect, test } from 'vitest';\nimport { isPos } from '../src/a.ts';\ntest('${name}', () => { expect(isPos(1)).toBe(true); expect(isPos(0)).toBe(false); });\n`;
    const root = project({ 'src/a.ts': 'export function isPos(n: number): boolean {\n  return n > 0;\n}\n', 'test/a.test.ts': t('a') });
    await runMutation({ root, concurrency: 1 });
    write(root, 'test/b.test.ts', t('b'));
    await runMutation({ root, concurrency: 1 });
    rmSync(join(root, 'test/a.test.ts'));
    await expectSameAsCold(root);
  });

  test('editing a function that only runs at module load', async () => {
    const root = project({
      'src/a.ts': 'function compute(): number {\n  return 1 + 1;\n}\nexport const X = compute();\n',
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { X } from '../src/a.ts';\ntest('x', () => { expect(X).toBe(2); });\n",
    });
    await runMutation({ root, concurrency: 1 });
    write(root, 'src/a.ts', 'function compute(): number {\n  const y = 3;\n  return y > 2 ? 1 + 1 : 0;\n}\nexport const X = compute();\n');
    await expectSameAsCold(root);
  });

  test('swapping same-named methods of different objects', async () => {
    const body = '  run(n: number): boolean {\n    return n > 0;\n  },\n';
    const root = project({
      'src/a.ts': `export const tested = {\n${body}};\nexport const untested = {\n${body}};\n`,
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { tested } from '../src/a.ts';\ntest('t', () => { expect(tested.run(1)).toBe(true); expect(tested.run(0)).toBe(false); });\n",
    });
    await runMutation({ root, concurrency: 1 });
    write(root, 'src/a.ts', `export const untested = {\n${body}};\nexport const tested = {\n${body}};\n`);
    await expectSameAsCold(root);
  });

  test('a partial dry run keeps hit limits of skipped test files', async () => {
    const root = project({
      'src/a.ts': 'export function isPos(n: number): boolean {\n  return n > 0;\n}\n',
      'test/a.test.ts':
        "import { expect, test } from 'vitest';\nimport { isPos } from '../src/a.ts';\ntest('loop', () => { let c = 0; for (let i = 0; i < 20000; i++) if (isPos(5)) c++; expect(c).toBe(20000); });\n",
      'test/b.test.ts': "import { expect, test } from 'vitest';\nimport { isPos } from '../src/a.ts';\ntest('once', () => { expect(isPos(1)).toBe(true); });\n",
    });
    await runMutation({ root, concurrency: 1 });
    write(root, 'test/b.test.ts', `${readFileSync(join(root, 'test/b.test.ts'), 'utf8')}// touched\n`);
    await expectSameAsCold(root);
  });

  test('turning arid suppression off re-plans the newly enabled mutants', async () => {
    const root = project({
      'src/a.ts': 'export function f(a: number): number {\n  console.log(a + 1);\n  return a * 2;\n}\n',
      'test/a.test.ts': "import { expect, test, vi } from 'vitest';\nimport { f } from '../src/a.ts';\ntest('f', () => { const spy = vi.spyOn(console, 'log').mockImplementation(() => {}); expect(f(2)).toBe(4); expect(spy).toHaveBeenCalledWith(3); });\n",
    });
    const first = await runMutation({ root, concurrency: 1 });
    expect(first.entries.find((e) => e.mutant.original === 'a + 1')!.status).toBe('Ignored');
    const incremental = await runMutation({ root, concurrency: 1, arid: false });
    const cold = await runMutation({ root, concurrency: 1, arid: false, snapshotPath: join(root, '.mutator/cold.json') });
    expect(verdicts(incremental)).toEqual(verdicts(cold));
    expect(incremental.entries.find((e) => e.mutant.original === 'a + 1')!.status).toBe('Killed');
  });

  test('experimental call graph keeps survivors of unrelated functions', async () => {
    const root = project({
      'src/a.ts': 'export function edited(n: number): number {\n  return n + 1;\n}\nexport function bystander(n: number): boolean {\n  return n >= 0;\n}\n',
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { bystander, edited } from '../src/a.ts';\ntest('both', () => { expect(edited(1)).toBe(2); expect(bystander(5)).toBe(true); });\n",
    });
    const runEdit = async (callGraph: boolean) => {
      const snapshotPath = join(root, `.mutator/${callGraph}.json`);
      write(root, 'src/a.ts', 'export function edited(n: number): number {\n  return n + 1;\n}\nexport function bystander(n: number): boolean {\n  return n >= 0;\n}\n');
      await runMutation({ root, concurrency: 1, callGraph, snapshotPath });
      write(root, 'src/a.ts', 'export function edited(n: number): number {\n  return 1 + n;\n}\nexport function bystander(n: number): boolean {\n  return n >= 0;\n}\n');
      const report = await runMutation({ root, concurrency: 1, callGraph, snapshotPath });
      return new Set(report.entries.filter((e) => e.source === 'run').map((e) => e.mutant.scope.id));
    };
    expect(await runEdit(false)).toEqual(new Set(['edited', 'bystander']));
    expect(await runEdit(true)).toEqual(new Set(['edited']));
  });
});
