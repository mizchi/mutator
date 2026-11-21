// Type checking of mutants is bounded by the run's time budget and limited to the sampled mutants.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mutant } from '@mizchi/mutator-core';
import type { TypeChecker } from '@mizchi/mutator-typecheck';
import { afterEach, describe, expect, test } from 'vitest';
import { type Report, runMutation } from '../src/run.ts';
import { readSnapshot } from '../src/snapshot.ts';
import type { TypecheckCache } from '../src/typecheck-cache.ts';
import { typecheckJobs } from '../src/typecheck.ts';

const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const mutant = (n: number) => ({ key: `k${n}`, file: `/nowhere/src/m${n}.ts` }) as unknown as Mutant;

describe('typecheckJobs under a deadline', () => {
  function fakeChecker(clock: { now: number }, calls: string[][]): TypeChecker {
    return {
      version: 'fake',
      inputs: { files: [], directories: [], directoryChecks: [], searches: [] },
      check(mutants) {
        calls.push(mutants.map((m) => m.key));
        clock.now += 10 * mutants.length;
        return new Map(mutants.filter((m) => m.key === 'k1').map((m) => [m.key, 'TS2322 bad']));
      },
      equivalent: () => new Map(),
      close: () => {},
    };
  }

  test('stops type-checking once the deadline passes and reports the rest as unchecked', async () => {
    const clock = { now: 0 };
    const calls: string[][] = [];
    const mutants = [0, 1, 2, 3, 4, 5].map(mutant);
    const result = await typecheckJobs('/nowhere', 'auto', mutants, () => {}, {
      deadline: 25,
      now: () => clock.now,
      batchSize: 2,
      createChecker: async () => fakeChecker(clock, calls),
    });
    expect(calls).toEqual([['k0', 'k1'], ['k2', 'k3']]);
    expect([...result.errors]).toEqual([['k1', 'TS2322 bad']]);
    expect([...result.unchecked].sort()).toEqual(['k4', 'k5']);
    // Unchecked mutants must not be cached as type-correct.
    expect(Object.keys(result.cache?.results ?? {}).sort()).toEqual(['k0', 'k1', 'k2', 'k3']);
  });

  test('checks nothing when the deadline has already passed', async () => {
    const clock = { now: 100 };
    const calls: string[][] = [];
    const result = await typecheckJobs('/nowhere', 'auto', [mutant(0), mutant(1)], () => {}, {
      deadline: 50,
      now: () => clock.now,
      createChecker: async () => fakeChecker(clock, calls),
    });
    expect(calls).toEqual([]);
    expect([...result.unchecked].sort()).toEqual(['k0', 'k1']);
  });

  test('without a deadline every mutant is checked', async () => {
    const clock = { now: 0 };
    const calls: string[][] = [];
    const result = await typecheckJobs('/nowhere', 'auto', [0, 1, 2].map(mutant), () => {}, {
      batchSize: 2,
      createChecker: async () => fakeChecker(clock, calls),
    });
    expect(calls.flat()).toEqual(['k0', 'k1', 'k2']);
    expect(result.unchecked.size).toBe(0);
  });

  test('a checker whose inputs cannot be listed keeps its verdicts, uncached', async () => {
    const logs: string[] = [];
    const failing: TypeChecker = { ...fakeChecker({ now: 0 }, []), get inputs(): never { throw new Error('no listing'); } };
    const result = await typecheckJobs('/nowhere', 'auto', [0, 1].map(mutant), (message) => logs.push(message), { createChecker: async () => failing });
    expect([...result.errors]).toEqual([['k1', 'TS2322 bad']]);
    expect(result.cache).toBeUndefined();
    expect(logs).toContain('typecheck inputs not listed, so the verdicts are not cached: no listing');
  });

  test('without a deadline all mutants go in one call', async () => {
    const calls: string[][] = [];
    await typecheckJobs('/nowhere', 'auto', [0, 1, 2].map(mutant), () => {}, { createChecker: async () => fakeChecker({ now: 0 }, calls) });
    expect(calls).toEqual([['k0', 'k1', 'k2']]);
  });
});

describe('typecheckJobs without a checker', () => {
  const mutants = [mutant(0)];

  test('auto says why type checking is skipped', async () => {
    const logs: string[] = [];
    const result = await typecheckJobs('/nowhere', 'auto', mutants, (message) => logs.push(message), { createChecker: async () => undefined });
    expect(result.errors.size).toBe(0);
    expect(logs).toEqual([expect.stringMatching(/^typecheck skipped: needs a tsconfig\.json and either the typescript package or Bun 1\.4\+/)]);
  });

  test('true fails with the same reason', async () => {
    await expect(typecheckJobs('/nowhere', true, mutants, () => {}, { createChecker: async () => undefined })).rejects.toThrow(/^typecheck: needs a tsconfig\.json/);
  });
});

describe('runs with type checking', { timeout: 120_000 }, () => {
  const CONFIG = `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n`;
  function project(): string {
    const root = join(tmpRoot, `tcb-${process.pid}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    const files = {
      'vitest.config.ts': CONFIG,
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', allowImportingTsExtensions: true }, include: ['src'] }),
      'src/a.ts': 'export function size(o?: { n: number }): number | undefined {\n  return o?.n;\n}\nexport function clamp(n: number, max: number): number {\n  return n > max && n >= 0 ? max : n + 0;\n}\n',
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { clamp, size } from '../src/a.ts';\ntest('a', () => { expect(size({ n: 1 })).toBe(1); expect(size()).toBe(undefined); expect(clamp(5, 3)).toBe(3); expect(clamp(1, 3)).toBe(1); });\n",
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    return root;
  }
  const typecheckedKeys = (root: string, snapshot: string) => Object.keys(((readSnapshot(join(root, snapshot), root) as { typecheck?: TypecheckCache } | undefined)?.typecheck?.results) ?? {});
  const skipped = (report: Report) => report.entries.filter((e) => e.source === 'skipped').map((e) => e.mutant.key);

  test('with --mutants-per-line only the sampled mutants are type-checked', async () => {
    const root = project();
    const report = await runMutation({ root, concurrency: 1, mutantsPerLine: 1 });
    const out = skipped(report);
    expect(out.length).toBeGreaterThan(0);
    const checked = typecheckedKeys(root, '.mutator/snapshot.json');
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.filter((key) => out.includes(key))).toEqual([]);
  });

  test('an exhausted budget leaves mutants Pending instead of type-checking them; the next run checks and runs them', async () => {
    const root = project();
    const cold = await runMutation({ root, concurrency: 1, snapshotPath: join(root, '.mutator/cold.json') });
    expect(cold.entries.some((e) => e.status === 'CompileError')).toBe(true);

    const logs: string[] = [];
    const none = await runMutation({ root, concurrency: 1, timeBudget: 0, log: (m) => logs.push(m) });
    expect(logs.some((m) => m.startsWith('typecheck ('))).toBe(false);
    expect(none.executed).toBe(0);
    expect(none.entries.some((e) => e.status === 'CompileError')).toBe(false);
    const pending = skipped(none);
    expect(pending.length).toBeGreaterThan(0);
    expect(none.notRun).toEqual({ sampled: 0, budget: pending.length });
    expect(typecheckedKeys(root, '.mutator/snapshot.json')).toEqual([]);

    const full = await runMutation({ root, concurrency: 1 });
    const verdicts = (r: Report) => Object.fromEntries(r.entries.map((e) => [e.mutant.key, e.status]));
    expect(verdicts(full)).toEqual(verdicts(cold));
  });
});
