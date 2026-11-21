import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineMutator } from '@mizchi/mutator-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runMutation } from '../src/run.ts';
import { fixtureGit as git } from './fixture-git.ts';

// Only a missing Bun skips; one that fails to start fails the tests.
const hasBun = (spawnSync('bun', ['--version']).error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT';
const fixture = fileURLToPath(new URL('../../bun/test/fixtures/basic', import.meta.url));
const tmpRoot = fileURLToPath(new URL('../.tmp', import.meta.url));

describe.skipIf(!hasBun)('runMutation with Bun', { timeout: 120_000 }, () => {
  let root: string;
  beforeEach(() => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `bun-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const byStatus = (report: Awaited<ReturnType<typeof runMutation>>) => {
    const out: Record<string, string[]> = {};
    for (const r of report.entries) (out[r.status] ??= []).push(`${r.mutant.original} -> ${r.mutant.replacement}`);
    return out;
  };

  test('classifies mutants, then a second run reuses everything', async () => {
    const first = await runMutation({ root, runner: 'bun', concurrency: 2 });
    const statuses = byStatus(first);
    expect(statuses.Killed).toContain('a + b -> a - b');
    expect(statuses.Killed).toContain('10 * 2 -> 10 / 2');
    expect(statuses.Survived).toContain('age >= 18 -> age > 18');
    expect(statuses.NoCoverage).toContain('x * 3 -> x / 3');
    expect(statuses.Timeout).toContain('i-- -> i++');
    expect(first.executed).toBeGreaterThan(0);

    const second = await runMutation({ root, runner: 'bun' });
    expect(second.executed).toBe(0);
    expect(second.dryRunFiles).toEqual([]);
    expect(byStatus(second)).toEqual(statuses);
  });

  test('editing an uncovered function runs nothing again', async () => {
    await runMutation({ root, runner: 'bun' });
    writeFileSync(join(root, 'src/math.ts'), readFileSync(join(root, 'src/math.ts'), 'utf8').replace('return x * 3;', 'return x * 4;'));
    const edited = await runMutation({ root, runner: 'bun' });
    expect(edited.executed).toBe(0);
    expect(byStatus(edited).NoCoverage).toContain('x * 4 -> x / 4');
  });

  test('with --since, a changed test file Bun does not collect is reported', async () => {
    mkdirSync(join(root, '__tests__'));
    writeFileSync(join(root, '__tests__/extra.ts'), "import { test } from 'bun:test';\ntest('x', () => {});\n");
    const report = await runMutation({ root, runner: 'bun', since: 'HEAD' });
    expect(report.uncollectedTests).toEqual(['__tests__/extra.ts']);
  });

  test('a *_test.* file under src is one of the tests, not a source to mutate', async () => {
    writeFileSync(join(root, 'src/sum_test.ts'), "import { expect, test } from 'bun:test';\nimport { add } from './math.ts';\ntest('sum', () => expect(add(10, 10)).toBe(20));\n");
    const report = await runMutation({ root, runner: 'bun' });
    expect(new Set(report.entries.map((e) => e.mutant.file))).toEqual(new Set([join(root, 'src/math.ts')]));
    expect(report.entries.find((e) => e.mutant.original === 'a + b' && e.mutant.replacement === 'a - b')?.coveredBy.sort()).toEqual(['src/sum_test.ts#sum', 'test/math.test.ts#add']);
  });

  test('plugin objects and modules reach the instrumentation (it runs in this process)', async () => {
    const zeroAge = defineMutator({ name: 'ZeroAge', visit(node) { if (node.type === 'Literal' && node.value === 18) return [{ replacement: '0' }]; } });
    const report = await runMutation({ root, runner: 'bun', plugins: [{ name: 'p', mutators: [zeroAge] }], concurrency: 2 });
    expect(byStatus(report).Killed).toContain('18 -> 0');
  });

  test('auto picks bun in a Bun project', async () => {
    writeFileSync(join(root, 'bunfig.toml'), '[test]\n');
    const logs: string[] = [];
    // The fixture sits inside the workspace, where vitest resolves: make the runner explicit
    // through the config file instead, and check detection itself in runner.test.ts.
    const report = await runMutation({ root, bunConfigFile: join(root, 'bunfig.toml'), log: (m) => logs.push(m) });
    expect(logs).toContain('runner: bun');
    expect(byStatus(report).Killed).toContain('a + b -> a - b');
  });

  test('type errors come from Bun\'s checker when it bundles the TypeScript major of the project', async () => {
    // The workspace's own typescript (7) resolves from the fixture.
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', allowImportingTsExtensions: true, skipLibCheck: true }, include: ['src'] }));
    const logs: string[] = [];
    const report = await runMutation({ root, runner: 'bun', log: (m) => logs.push(m) });
    expect(logs).toContainEqual(expect.stringMatching(/^typecheck \(TypeScript 7\.\d+\.\d+ via bun check\): \d+ mutants/));
    expect(byStatus(report).CompileError?.length).toBeGreaterThan(0);
  });
});
