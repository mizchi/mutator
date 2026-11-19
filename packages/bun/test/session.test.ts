import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@mizchi/mutator-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBunSession, pathFilter } from '../src/session.ts';

const hasBun = !spawnSync('bun', ['--version']).error;
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('the plugin filter matches exactly the targets, with either separator', () => {
  const filter = new RegExp(pathFilter(['/p/src/a.ts', '/p/src/b+c.ts', '/p/lib/a.ts', 'C:\\p\\src\\d.ts']));
  for (const hit of ['/p/src/a.ts', '/p/src/b+c.ts', '/p/lib/a.ts', '\\p\\src\\a.ts', 'C:\\p\\src\\d.ts', 'C:/p/src/d.ts']) expect(filter.test(hit), hit).toBe(true);
  for (const miss of ['/p/src/a.tsx', '/p/src/bbc.ts', '/p/lib/b+c.ts', '/q/p/src/a.ts', '/p/src/a.ts/x']) expect(filter.test(miss), miss).toBe(false);
});

describe.skipIf(!hasBun)('bun session', { timeout: 60_000 }, () => {
  describe('basic fixture', () => {
    const root = fixture('basic');
    const T = 'test/math.test.ts';
    let session: Session;
    beforeAll(async () => {
      session = await createBunSession({ root, targets: [join(root, 'src/math.ts')] });
    });
    afterAll(async () => {
      await session?.close();
    });

    const find = (original: string, replacement: string) => {
      const m = session.mutants().find((m) => m.original === original && m.replacement === replacement);
      if (!m) throw new Error(`mutant ${original} -> ${replacement} not found`);
      return m;
    };

    test('lists test files the way bun test collects them', async () => {
      expect(await session.testFiles()).toEqual([join(root, T)]);
      expect(session.configFiles()).toEqual([]);
    });

    test('dry run collects tests, per-test coverage, infection, static coverage and dependencies', async () => {
      const dry = await session.dryRun();
      expect(dry.failed).toEqual([]);
      expect(dry.tests.map((t) => t.id)).toEqual([`${T}#add`, `${T}#isAdult adult`, `${T}#isAdult child`, `${T}#limit`, `${T}#countdown`]);
      expect(dry.tests.every((t) => t.fingerprint.length > 0 && t.durationMs >= 0)).toBe(true);
      expect(dry.coverage.get(find('a + b', 'a - b').key)).toEqual([`${T}#add`]);
      expect(dry.coverage.get(find('age >= 18', 'age > 18').key)).toEqual([`${T}#isAdult adult`, `${T}#isAdult child`]);
      expect(dry.coverage.get(find('x * 3', 'x / 3').key) ?? []).toEqual([]);
      // 30 and 3 both give the same answer for `age > 18`: no test infects it.
      expect(dry.infected?.get(find('age >= 18', 'age > 18').key)).toBeUndefined();
      expect(dry.infected?.get(find('a + b', 'a - b').key)).toEqual([`${T}#add`]);
      expect(dry.staticKeys.has(find('10 * 2', '10 / 2').key)).toBe(true);
      expect(dry.staticByFile.get(T)?.has(find('10 * 2', '10 / 2').key)).toBe(true);
      expect(dry.hits.get(find('a + b', 'a - b').key)).toBe(1);
      // The skipped test is indexed (its id stays stable) but not run.
      expect(dry.index.get(`${T}#isAdult skipped`)).toEqual({ moduleId: join(root, T), taskId: 'isAdult skipped' });
      expect(dry.index.get(`${T}#isAdult adult`)).toEqual({ moduleId: join(root, T), taskId: 'isAdult adult' });
      expect(Object.fromEntries(dry.deps)).toEqual({ [T]: ['src/math.ts'] });
    });

    test('a covered mutant is killed by the covering test', async () => {
      const result = await session.runMutant(find('a + b', 'a - b').key, [`${T}#add`], { timeoutMs: 10_000 });
      expect(result.status).toBe('Killed');
      expect(result.killedBy).toEqual([`${T}#add`]);
    });

    test('a boundary mutant survives', async () => {
      const result = await session.runMutant(find('age >= 18', 'age > 18').key, [`${T}#isAdult adult`, `${T}#isAdult child`], { timeoutMs: 10_000 });
      expect(result).toMatchObject({ status: 'Survived', killedBy: [] });
    });

    test('static mutants are active while the module loads', async () => {
      const result = await session.runMutant(find('10 * 2', '10 / 2').key, [`${T}#limit`], { timeoutMs: 10_000, isStatic: true });
      expect(result).toMatchObject({ status: 'Killed', killedBy: [`${T}#limit`] });
    });

    test('only the selected tests run', async () => {
      const result = await session.runMutant(find('a + b', 'a - b').key, [`${T}#limit`], { timeoutMs: 10_000 });
      expect(result.status).toBe('Survived');
    });

    test('an endless loop stops at the hit limit and is a timeout', async () => {
      const result = await session.runMutant(find('i--', 'i++').key, [`${T}#countdown`], { timeoutMs: 20_000, hitLimit: 1000 });
      expect(result).toMatchObject({ status: 'Timeout', timeoutCause: 'hitLimit' });
    });

    test('a run exceeding the time limit is killed and reported as a timeout', async () => {
      const started = performance.now();
      // No hit limit: only the wall-clock timeout can stop it.
      const result = await session.runMutant(find('i--', 'i++').key, [`${T}#countdown`], { timeoutMs: 1000, hitLimit: Number.MAX_SAFE_INTEGER });
      expect(result).toMatchObject({ status: 'Timeout', timeoutCause: 'time' });
      expect(performance.now() - started).toBeLessThan(20_000);
    });

    test('a second session reuses the dry-run index and shares the instrumented sources', async () => {
      const other = await createBunSession({ root, targets: [join(root, 'src/math.ts')] });
      try {
        other.useTestIndex((await session.dryRun()).index);
        expect(other.mutants()).toBe(session.mutants());
        const result = await other.runMutant(find('a + b', 'a - b').key, [`${T}#add`], { timeoutMs: 10_000 });
        expect(result.status).toBe('Killed');
      } finally {
        await other.close();
      }
      // The first session still runs after the second one closed.
      expect((await session.runMutant(find('a + b', 'a - b').key, [`${T}#add`], { timeoutMs: 10_000 })).status).toBe('Killed');
    });
  });

  describe('a mutant failing several test files', () => {
    const root = fixture('matrix');
    const A = 'test/a.test.ts#a';
    const B = 'test/b.test.ts#b';
    let session: Session;
    let key: string;
    let tests: string[];
    beforeAll(async () => {
      session = await createBunSession({ root, targets: [join(root, 'src/add.ts')], maxWorkers: 2 });
      const dry = await session.dryRun();
      key = session.mutants().find((m) => m.original === 'a + b' && m.replacement === 'a - b')!.key;
      tests = dry.coverage.get(key)!;
    });
    afterAll(async () => {
      await session?.close();
    });

    test('both test files cover it (dry run with --parallel)', () => {
      expect([...tests].sort()).toEqual([A, B]);
    });

    test('with early exit it is killed by the first failing test', async () => {
      const result = await session.runMutant(key, tests, { timeoutMs: 10_000 });
      expect(result.status).toBe('Killed');
      expect(result.killedBy).toHaveLength(1);
      expect([A, B]).toContain(result.killedBy[0]);
    });

    test('without early exit every failing test file runs (kill matrix)', async () => {
      const result = await session.runMutant(key, tests, { timeoutMs: 10_000, earlyExit: false });
      expect(result.status).toBe('Killed');
      expect([...result.killedBy].sort()).toEqual([A, B]);
    });
  });

  test('a mutant that breaks loading several test files is a runtime error', async () => {
    const root = fixture('loaderror');
    const session = await createBunSession({ root, targets: [join(root, 'src/config.ts')] });
    try {
      const dry = await session.dryRun();
      expect(dry.failed).toEqual([]);
      const mutant = session.mutants().find((m) => m.original === '2 + 1' && m.replacement === '2 - 1')!;
      expect(dry.staticByFile.get('test/a.test.ts')?.has(mutant.key)).toBe(true);
      expect(dry.staticByFile.get('test/b.test.ts')?.has(mutant.key)).toBe(true);
      const tests = ['test/a.test.ts#a', 'test/b.test.ts#b'];
      const all = await session.runMutant(mutant.key, tests, { timeoutMs: 10_000, isStatic: true, earlyExit: false });
      expect(all).toMatchObject({ status: 'RuntimeError', killedBy: ['test/a.test.ts', 'test/b.test.ts'] });
      // --bail stops at the first file that fails to load.
      const first = await session.runMutant(mutant.key, tests, { timeoutMs: 10_000, isStatic: true });
      expect(first.status).toBe('RuntimeError');
      expect(first.killedBy).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  test('concurrent tests share the hits of their file', async () => {
    const root = fixture('concurrent');
    const session = await createBunSession({ root, targets: [join(root, 'src/value.ts')] });
    try {
      const dry = await session.dryRun();
      expect(dry.failed).toEqual([]);
      const covering = (original: string) => dry.coverage.get(session.mutants().find((m) => m.original === original && m.replacement !== original)!.key);
      expect(covering('n * 2')).toEqual(['test/value.test.ts#double', 'test/value.test.ts#triple']);
      expect(covering('n * 3')).toEqual(['test/value.test.ts#double', 'test/value.test.ts#triple']);
    } finally {
      await session.close();
    }
  });

  test('the dry run records the processes each test starts', async () => {
    const root = fixture('spawn');
    const session = await createBunSession({ root, targets: [join(root, 'src/cli.ts')] });
    try {
      const dry = await session.dryRun();
      expect(dry.failed).toEqual([]);
      const bun = realpathSync(spawnSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8' }).stdout.trim());
      expect(Object.fromEntries(dry.spawns ?? [])).toEqual({
        'test/cli.test.ts#greets through Bun.spawnSync': [{ argv: [bun, 'src/cli.ts', 'b'], cwd: root }],
        'test/cli.test.ts#greets through child_process': [{ argv: [bun, 'src/cli.ts', 'c'], cwd: root }],
      });
    } finally {
      await session.close();
    }
  });

  test('a test whose name the report cannot hold still runs for the mutants it covers', async () => {
    const root = fixture('names');
    const session = await createBunSession({ root, targets: [join(root, 'src/scheme.ts')] });
    try {
      const dry = await session.dryRun();
      expect(dry.failed).toEqual([]);
      // The NUL is gone from the reported name.
      const id = 'test/scheme.test.ts#javascript:';
      expect(dry.tests.map((t) => t.id)).toEqual([id, 'test/scheme.test.ts#plain']);
      // Only the test named with a NUL fails on it.
      const mutant = session.mutants().find((m) => m.original === "input.startsWith('\\0')" && m.replacement === 'false')!;
      expect(dry.coverage.get(mutant.key)).toEqual([id, 'test/scheme.test.ts#plain']);
      const result = await session.runMutant(mutant.key, [id, 'test/scheme.test.ts#plain'], { timeoutMs: 10_000 });
      expect(result).toMatchObject({ status: 'Killed', killedBy: [id] });
    } finally {
      await session.close();
    }
  });

  test('a mutant that ends the process before the report is a runtime error', async () => {
    const root = fixture('exit');
    const session = await createBunSession({ root, targets: [join(root, 'src/guard.ts')] });
    try {
      expect((await session.dryRun()).failed).toEqual([]);
      const mutant = session.mutants().find((m) => m.original === '!ok' && m.replacement === 'ok')!;
      const result = await session.runMutant(mutant.key, ['test/guard.test.ts#check'], { timeoutMs: 10_000 });
      expect(result.status).toBe('RuntimeError');
    } finally {
      await session.close();
    }
  });

  test('closing the last session removes the instrumented sources', async () => {
    const root = fixture('matrix');
    const listed = () => readdirSync(tmpdir()).filter((d) => d.startsWith('mutator-bun-'));
    const before = new Set(listed());
    // Options no other session uses, so this one instruments its own copy.
    const session = await createBunSession({ root, targets: [join(root, 'src/add.ts')], excludedMutators: ['BlockStatement'] });
    const created = listed().filter((d) => !before.has(d));
    expect(created).toHaveLength(1);
    await session.close();
    expect(existsSync(join(tmpdir(), created[0]!))).toBe(false);
  });
});
