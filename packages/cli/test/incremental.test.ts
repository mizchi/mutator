// Edit sequences found by review: an incremental run must give the same verdicts as a cold run.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { formatSummary } from '../src/report.ts';
import { BaselineError, type Report, runMutation } from '../src/run.ts';
import { readSnapshot } from '../src/snapshot.ts';
import { fixtureGit } from './fixture-git.ts';

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

  describe('narrowed re-collection', () => {
    const files = {
      'src/a.ts': 'export const LIMIT = 10;\nexport function clamp(n: number): number {\n  return n > LIMIT ? -1 : n;\n}\nexport function other(n: number): number {\n  return n * 2;\n}\n',
      'src/b.ts': "import { LIMIT } from './a.ts';\nexport function limited(n: number): boolean {\n  return n < LIMIT;\n}\n",
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { clamp } from '../src/a.ts';\ntest('clamp', () => { expect(clamp(1)).toBe(1); expect(clamp(100)).toBe(-1); });\n",
      'test/b.test.ts': "import { expect, test } from 'vitest';\nimport { other } from '../src/a.ts';\ntest('other', () => { expect(other(2)).toBe(4); });\n",
      'test/c.test.ts': "import { expect, test } from 'vitest';\nimport { limited } from '../src/b.ts';\ntest('limited', () => { expect(limited(1)).toBe(true); expect(limited(50)).toBe(false); });\n",
    };

    test('a pure top-level change re-collects only tests of the functions using it', async () => {
      const root = project(files);
      await runMutation({ root, concurrency: 1 });
      edit(root, 'src/a.ts', 'LIMIT = 10', 'LIMIT = 3');
      const report = await expectSameAsCold(root);
      expect(report.dryRunFiles).toEqual(['test/a.test.ts', 'test/c.test.ts']);
    });

    test('a new function called by an edited one re-collects only the tests of the caller', async () => {
      const root = project(files);
      await runMutation({ root, concurrency: 1 });
      edit(root, 'src/a.ts', 'return n * 2;', 'return twice(n);\n}\nfunction twice(n: number): number {\n  return n + n;');
      const report = await expectSameAsCold(root);
      expect(report.dryRunFiles).toEqual(['test/b.test.ts']);
    });

    test('names followed through a barrel re-export, and tests importing the name directly', async () => {
      const root = project({
        ...files,
        'src/index.ts': "export * from './a.ts';\n",
        'src/b.ts': "import { LIMIT } from './index.ts';\nexport function limited(n: number): boolean {\n  return n < LIMIT;\n}\n",
        'test/d.test.ts': "import { expect, test } from 'vitest';\nimport { LIMIT, other } from '../src/a.ts';\ntest('direct', () => { expect(other(LIMIT)).toBe(LIMIT * 2); });\n",
      });
      await runMutation({ root, concurrency: 1 });
      edit(root, 'src/a.ts', 'LIMIT = 10', 'LIMIT = 3');
      const report = await expectSameAsCold(root);
      expect(report.dryRunFiles).toEqual(['test/a.test.ts', 'test/c.test.ts', 'test/d.test.ts']);
    });

    test('a table built with calls and callbacks re-collects only tests of its readers', async () => {
      const table = "export const TABLE = [\n  ...[1, 2].map((n) => n * 10),\n  ...[5].map((n) => n + 1),\n];\nexport function lookup(i: number): number {\n  return TABLE[i] ?? -1;\n}\nexport function twice(n: number): number {\n  return n * 2;\n}\n";
      const root = project({ ...files, 'src/t.ts': table, 'test/t.test.ts': "import { expect, test } from 'vitest';\nimport { lookup } from '../src/t.ts';\nimport { other } from '../src/a.ts';\ntest('lookup', () => { expect(lookup(0)).toBe(10); expect(lookup(9)).toBe(-1); expect(other(1)).toBe(2); });\n", 'test/u.test.ts': "import { expect, test } from 'vitest';\nimport { twice } from '../src/t.ts';\ntest('unrelated', () => { expect(twice(3)).toBe(6); });\n" });
      await runMutation({ root, concurrency: 1 });
      edit(root, 'src/t.ts', '  ...[5]', '  ...[7].map((n) => n - 1),\n  ...[5]');
      const report = await expectSameAsCold(root);
      expect(report.dryRunFiles).toEqual(['test/t.test.ts']);
    });

    test('a side-effecting top-level change re-collects every importer', async () => {
      const root = project({ ...files, 'src/a.ts': `${files['src/a.ts']}export const seen: number[] = [];\nseen.push(1);\n` });
      await runMutation({ root, concurrency: 1 });
      edit(root, 'src/a.ts', 'seen.push(1);', 'seen.push(2);');
      const report = await expectSameAsCold(root);
      expect(report.dryRunFiles).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts']);
    });
  });

  describe('run-time inputs of tests', () => {
    const scale = 'export function scale(n: number, factor: number): number {\n  return n * factor;\n}\n';
    const verdict = (r: Report) => r.entries.find((e) => e.mutant.original === 'n * factor' && e.mutant.replacement === 'n / factor');
    const files = {
      'src/a.ts': scale,
      'fixtures/factor.json': '{ "factor": 1 }\n',
      'fixtures/unused.json': '{}\n',
      'test/a.test.ts': "import { readFileSync } from 'node:fs';\nimport { expect, test } from 'vitest';\nimport { scale } from '../src/a.ts';\nconst { factor } = JSON.parse(readFileSync(new URL('../fixtures/factor.json', import.meta.url), 'utf8'));\ntest('scale', () => { expect(scale(3, factor)).toBe(3 * factor); });\n",
      'test/b.test.ts': "import { expect, test } from 'vitest';\nimport { scale } from '../src/a.ts';\ntest('scale by env', () => { const factor = Number(process.env.MUTATOR_TEST_FACTOR ?? '1'); expect(scale(4, factor)).toBe(4 * factor); });\n",
    };

    test('changing a fixture a test reads re-runs the verdicts it covered', async () => {
      const root = project({ ...files, 'test/b.test.ts': "import { expect, test } from 'vitest';\nimport { scale } from '../src/a.ts';\ntest('other', () => { expect(scale(0, 5)).toBe(0); });\n" });
      expect(verdict(await runMutation({ root, concurrency: 1 }))?.status).toBe('Survived');
      edit(root, 'fixtures/factor.json', '1', '2');
      const report = await expectSameAsCold(root);
      expect(report.dryRunFiles).toEqual(['test/a.test.ts']);
      expect(verdict(report)).toMatchObject({ status: 'Killed', source: 'run' });
    });

    test('changing an environment variable a test reads re-runs the verdicts it covered', async () => {
      const root = project({ ...files, 'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { scale } from '../src/a.ts';\ntest('other', () => { expect(scale(0, 5)).toBe(0); });\n" });
      try {
        process.env.MUTATOR_TEST_FACTOR = '1';
        expect(verdict(await runMutation({ root, concurrency: 1 }))?.status).toBe('Survived');
        expect(verdict(await runMutation({ root, concurrency: 1 }))?.source).toBe('reuse');
        process.env.MUTATOR_TEST_FACTOR = '2';
        const report = await expectSameAsCold(root);
        expect(report.dryRunFiles).toEqual(['test/b.test.ts']);
        expect(verdict(report)).toMatchObject({ status: 'Killed', source: 'run' });
      } finally {
        delete process.env.MUTATOR_TEST_FACTOR;
      }
    });

    test('a fixture written during the run by another test does not enter the key of a test not re-collected', async () => {
      const root = project({ ...files, 'test/b.test.ts': "import { expect, test } from 'vitest';\ntest('other', () => { expect(1).toBe(1); });\n" });
      expect(verdict(await runMutation({ root, concurrency: 1 }))?.status).toBe('Survived');
      // Only test/b is re-collected, and it rewrites the fixture test/a read: test/a's verdicts predate that write.
      write(root, 'test/b.test.ts', "import { writeFileSync } from 'node:fs';\nimport { expect, test } from 'vitest';\ntest('other', () => { writeFileSync(new URL('../fixtures/factor.json', import.meta.url), '{ \"factor\": 2 }\\n'); expect(1).toBe(1); });\n");
      expect((await runMutation({ root, concurrency: 1 })).dryRunFiles).toEqual(['test/b.test.ts']);
      const report = await expectSameAsCold(root);
      expect(report.dryRunFiles).toContain('test/a.test.ts');
      expect(verdict(report)).toMatchObject({ status: 'Killed', source: 'run' });
    });

    test('changing a file no test read invalidates nothing', async () => {
      const root = project(files);
      await runMutation({ root, concurrency: 1 });
      edit(root, 'fixtures/unused.json', '{}', '{ "x": 1 }');
      const report = await runMutation({ root, concurrency: 1 });
      expect(report.dryRunFiles).toEqual([]);
      expect(report.entries.every((e) => e.source !== 'run')).toBe(true);
    });
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

  test.each([false, true])('reordering module initialization invalidates cached verdicts (fullDryRun: %s)', async (fullDryRun) => {
    const root = project({
      'src/limit.js': 'let limit;\nlimit = 3;\nlimit = 2;\nexport function fits(n) { return n <= limit; }\n',
      'test/limit.test.ts': "import { expect, test } from 'vitest';\nimport { fits } from '../src/limit.js';\ntest('bounds', () => expect([1, 2, 4].map(fits)).toEqual([true, true, false]));\n",
      'test/other.test.ts': "import { expect, test } from 'vitest';\ntest('other', () => expect(1).toBe(1));\n",
    });
    const before = await runMutation({ root, concurrency: 1 });
    const boundary = before.entries.find((e) => e.mutant.replacement === 'n < limit')!;
    expect(boundary.status).toBe('Killed');
    edit(root, 'src/limit.js', 'limit = 3;\nlimit = 2;', 'limit = 2;\nlimit = 3;');

    const warm = await runMutation({ root, concurrency: 1, fullDryRun });
    const cold = await runMutation({ root, concurrency: 1, snapshotPath: join(root, '.mutator/cold.json') });
    expect(cold.entries.find((e) => e.mutant.key === boundary.mutant.key)?.status).toBe('Survived');
    expect(verdicts(warm)).toEqual(verdicts(cold));
    expect(warm.dryRunFiles).toEqual(fullDryRun ? ['test/limit.test.ts', 'test/other.test.ts'] : ['test/limit.test.ts']);
  });

  test.each(['generic', 'edited'])('reordering module initialization can break the baseline (%s callback)', async (next) => {
    const root = project({
      'src/routes.js': "const routes = [];\nfunction register(f) { routes.push(f); }\nregister(() => 'specific');\nregister(() => 'generic');\nexport function first() { return routes[0](); }\n",
      'test/routes.test.ts': "import { expect, test } from 'vitest';\nimport { first } from '../src/routes.js';\ntest('priority', () => expect(first()).toBe('specific'));\n",
    });
    await runMutation({ root, concurrency: 1 });
    edit(root, 'src/routes.js', "register(() => 'specific');\nregister(() => 'generic');", `register(() => '${next}');\nregister(() => 'specific');`);
    await expect(runMutation({ root, concurrency: 1 })).rejects.toBeInstanceOf(BaselineError);
  });

  test.each([';\nconst ', ', '])('moving and editing a declaration still checks module loading (%j)', async (separator) => {
    const source = 'src/values.js';
    const fn = '\nexport function f(n) { return n + 1; }\n';
    const root = project({
      [source]: `const a = 1${separator}b = a;${fn}`,
      'test/f.test.ts': "import { expect, test } from 'vitest';\nimport { f } from '../src/values.js';\ntest('f', () => expect(f(1)).toBe(2));\n",
    });
    await runMutation({ root, concurrency: 1 });
    write(root, source, `const b = a${separator}a = 2;${fn}`);
    await expect(runMutation({ root, concurrency: 1 })).rejects.toBeInstanceOf(BaselineError);
    await expect(runMutation({ root, concurrency: 1, snapshotPath: join(root, '.mutator/cold.json') })).rejects.toBeInstanceOf(BaselineError);
  });

  test('reordering side-effect imports checks the tests that load the module', async () => {
    const root = project({
      'src/state.js': 'export const routes = [];\n',
      'src/specific.js': "import { routes } from './state.js';\nroutes.push('specific');\n",
      'src/generic.js': "import { routes } from './state.js';\nroutes.push('generic');\n",
      'src/routes.js': "import './specific.js';\nimport './generic.js';\nexport { routes } from './state.js';\n",
      'test/routes.test.ts': "import { expect, test } from 'vitest';\nimport { routes } from '../src/routes.js';\ntest('priority', () => expect(routes[0]).toBe('specific'));\n",
    });
    await runMutation({ root, concurrency: 1 });
    edit(root, 'src/routes.js', "import './specific.js';\nimport './generic.js';", "import './generic.js';\nimport './specific.js';");
    await expect(runMutation({ root, concurrency: 1 })).rejects.toBeInstanceOf(BaselineError);
    await expect(runMutation({ root, concurrency: 1, snapshotPath: join(root, '.mutator/cold.json') })).rejects.toBeInstanceOf(BaselineError);
  });

  test('moving hoisted function declarations still reuses their results', async () => {
    const a = 'export function a(n) { return n + 1; }\n';
    const b = 'export function b(n) { return n * 2; }\n';
    const root = project({
      'src/math.js': a + b,
      'test/math.test.ts': "import { expect, test } from 'vitest';\nimport { a, b } from '../src/math.js';\ntest('both', () => expect(b(a(2))).toBe(6));\n",
    });
    await runMutation({ root, concurrency: 1 });
    write(root, 'src/math.js', b + a);
    const warm = await runMutation({ root, concurrency: 1 });
    expect(warm.dryRunFiles).toEqual([]);
    expect(warm.executed).toBe(0);
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

describe('worker crashes', () => {
  test('a mutant that exhausts worker memory does not abort the run', { timeout: 300_000 }, () => {
    const fixture = fileURLToPath(new URL('./fixtures/oom', import.meta.url));
    const root = join(tmpRoot, `oom-${process.pid}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    cpSync(fixture, root, { recursive: true });
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const result = spawnSync(process.execPath, [cli, '--root', root, '-j', '1'], { encoding: 'utf8' });
    expect(result.stderr).not.toMatch(/Unhandled 'error' event/);
    expect(result.status).toBe(0);
    expect(existsSync(join(root, '.mutator/snapshot.json'))).toBe(true);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
});

describe('type checking', { timeout: 120_000 }, () => {
  test('type cache is invalidated by imported declarations without changing the function', async () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true, noEmit: true, target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext' }, include: ['src'] }),
      'src/types.d.ts': 'export type Box = { n: number } | undefined;\n',
      'src/a.ts': "import type { Box } from './types.js';\nexport function size(o: Box): number | undefined { return o?.n; }\n",
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { size } from '../src/a.ts';\ntest('size', () => { expect(size({ n: 1 })).toBe(1); });\n",
    });
    const unchained = (report: Report) => report.entries.find((e) => e.mutant.original === '?.')!;
    expect(unchained(await runMutation({ root, concurrency: 1 })).status).toBe('CompileError');
    write(root, 'src/types.d.ts', 'export type Box = { n: number };\n');
    const report = await expectSameAsCold(root);
    expect(unchained(report)).toMatchObject({ status: 'Ignored', reason: 'equivalent: o is never nullish' });
  });

  test('mutants that do not type-check are CompileError and are not run', async () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', allowImportingTsExtensions: true }, include: ['src'] }),
      'src/a.ts': 'export function size(o?: { n: number }): number | undefined {\n  return o?.n;\n}\nexport function evens(): number[] {\n  const out: number[] = [];\n  out.push(2);\n  return out;\n}\n',
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { evens, size } from '../src/a.ts';\ntest('a', () => { expect(size({ n: 1 })).toBe(1); expect(size()).toBe(undefined); expect(evens()).toEqual([2]); });\n",
    });
    const report = await runMutation({ root, concurrency: 1 });
    const status = (original: string, replacement: string) => report.entries.find((e) => e.mutant.original === original && e.mutant.replacement === replacement);
    expect(status('?.', '.')).toMatchObject({ status: 'CompileError', source: 'static' });
    expect(status('[]', '["Stryker was here!"]')).toMatchObject({ status: 'CompileError' });
    expect(report.entries.filter((e) => e.status === 'CompileError').every((e) => e.killedBy.length === 0)).toBe(true);

    // Parallel tests may create sibling projects. An existence probe of the parent
    // must not make their directory entries part of this project's type inputs.
    project({ 'src/unrelated.ts': 'export const unrelated = 1;\n' });
    const logs: string[] = [];
    const unchanged = await runMutation({ root, concurrency: 1, log: (message) => logs.push(message) });
    expect(verdicts(unchanged)).toEqual(verdicts(report));
    expect(logs.some((message) => message.startsWith('typecheck ('))).toBe(false);

    // Not re-collected after an unrelated edit: the type checker still sees them as covered.
    write(root, 'src/b.ts', 'export function inc(n: number): number {\n  return n + 1;\n}\n');
    write(root, 'test/b.test.ts', "import { expect, test } from 'vitest';\nimport { inc } from '../src/b.ts';\ntest('b', () => { expect(inc(1)).toBe(2); });\n");
    await runMutation({ root, concurrency: 1 });
    edit(root, 'src/b.ts', 'n + 1', '1 + n');
    const again = await expectSameAsCold(root);
    expect(again.dryRunFiles).toEqual(['test/b.test.ts']);

    const untyped = await runMutation({ root, concurrency: 1, typecheck: false, snapshotPath: join(root, '.mutator/untyped.json') });
    expect(untyped.entries.some((e) => e.status === 'CompileError')).toBe(false);
    expect(untyped.executed).toBeGreaterThan(report.executed);
  });

  test('mutants proven equivalent by types are Ignored with the reason, and kept so in the snapshot', async () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true, noEmit: true, target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', allowImportingTsExtensions: true }, include: ['src'] }),
      'src/a.ts': 'export function scaled(o: { k: number }, n: number): number {\n  return n * o?.k;\n}\nexport function size(o?: { n: number }): number | undefined {\n  return o?.n;\n}\n',
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { scaled, size } from '../src/a.ts';\ntest('a', () => { expect(scaled({ k: 2 }, 3)).toBe(6); expect(size({ n: 1 })).toBe(1); expect(size()).toBe(undefined); });\n",
    });
    const report = await runMutation({ root, concurrency: 1 });
    const unchained = (r: Report) => r.entries.filter((e) => e.mutant.original === '?.').map((e) => [e.mutant.location.start.line, e.status, e.reason]);
    expect(unchained(report)).toEqual([
      [2, 'Ignored', 'equivalent: o is never nullish'],
      [5, 'CompileError', undefined],
    ]);
    expect(formatSummary(report, root)).toMatch(/^equivalent by types: 1$/m);
    const saved = readSnapshot(join(root, '.mutator/snapshot.json'), root)!.results.find((r) => r.status === 'Ignored');
    expect(saved?.reason).toBe('equivalent: o is never nullish');

    // The next run decides it again, with the same reason.
    expect(unchained(await runMutation({ root, concurrency: 1 }))).toEqual(unchained(report));
    // Without type checking it runs and is not killed.
    const untyped = await runMutation({ root, concurrency: 1, typecheck: false, snapshotPath: join(root, '.mutator/untyped.json') });
    expect(untyped.entries.find((e) => e.mutant.original === '?.' && e.mutant.location.start.line === 2)?.status).toBe('Survived');
  });

  test('with --since, the mutants in the diff are type-checked alongside the dry run', async () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', allowImportingTsExtensions: true }, include: ['src'] }),
      'src/a.ts': 'export function size(o?: { n: number }): number | undefined {\n  return o?.n;\n}\nexport function twice(n: number): number {\n  return n * 2;\n}\n',
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { size, twice } from '../src/a.ts';\ntest('a', () => { expect(size({ n: 1 })).toBe(1); expect(size()).toBe(undefined); expect(twice(2)).toBe(4); });\n",
    });
    const git = (...args: string[]) => fixtureGit(root, ...args);
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'base');
    edit(root, 'src/a.ts', 'return o?.n;', 'return o?.n ?? undefined;');
    const logs: string[] = [];
    const report = await runMutation({ root, concurrency: 1, since: 'HEAD', log: (m) => logs.push(m) });
    expect(logs.some((m) => m.includes('alongside the dry run'))).toBe(true);
    expect(report.entries.find((e) => e.mutant.original === '?.' && e.mutant.replacement === '.')).toMatchObject({ status: 'CompileError' });
  });
});

