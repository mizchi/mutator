import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HIT_LIMIT_MESSAGE, type Session, classifyRun } from '@mizchi/mutator-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBunSession, fitsCommandLine, pathFilter, withFailures } from '../src/session.ts';

// Only a missing Bun skips; one that fails to start fails the tests.
const hasBun = (spawnSync('bun', ['--version']).error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT';
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('the plugin filter matches exactly the targets, with either separator', () => {
  const filter = new RegExp(pathFilter(['/p/src/a.ts', '/p/src/b+c.ts', '/p/lib/a.ts', 'C:\\p\\src\\d.ts']));
  for (const hit of ['/p/src/a.ts', '/p/src/b+c.ts', '/p/lib/a.ts', '\\p\\src\\a.ts', 'C:\\p\\src\\d.ts', 'C:/p/src/d.ts']) expect(filter.test(hit), hit).toBe(true);
  for (const miss of ['/p/src/a.tsx', '/p/src/bbc.ts', '/p/lib/b+c.ts', '/q/p/src/a.ts', '/p/src/a.ts/x']) expect(filter.test(miss), miss).toBe(false);
});

test('a command line fits within the platform limit', () => {
  const long = 'x'.repeat(20_000);
  expect(fitsCommandLine(['bun', long, long], 'linux')).toBe(true);
  expect(fitsCommandLine(['bun', 'x'.repeat(40_000)], 'linux')).toBe(false);
  // Windows limits the whole command line.
  expect(fitsCommandLine(['bun', long], 'win32')).toBe(true);
  expect(fitsCommandLine(['bun', long, long], 'win32')).toBe(false);
  // There, quotes and backslashes are escaped.
  expect(fitsCommandLine(['bun', '"'.repeat(17_000)], 'win32')).toBe(false);
});

test('a selected failure of the first run counts next to a different one in the rerun', () => {
  const selected = new Set(['t#a', 't#b']);
  const run = (tests: { id: string; failed: boolean; messages: string[] }[]) => ({ tests, fileErrors: [], runErrors: [], selected });
  // `a` failed an assertion first, then reached the hit limit in the rerun.
  const first = run([{ id: 't#a', failed: true, messages: ['expected 1 to be 2'] }, { id: 't#x', failed: true, messages: ['not selected'] }]);
  const rerun = run([{ id: 't#a', failed: true, messages: [HIT_LIMIT_MESSAGE] }, { id: 't#b', failed: false, messages: [] }]);
  expect(classifyRun(rerun).status).toBe('Timeout');
  expect(classifyRun(withFailures(rerun, first))).toMatchObject({ status: 'Killed', killedBy: ['t#a'] });
  // Only selected tests are added.
  expect(withFailures(rerun, first).tests.map((t) => t.id)).toEqual(['t#a', 't#b', 't#a']);
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

    test('a failing test that was not selected does not stop the selected ones', async () => {
      // A whole-file run, as for a static mutant: --bail stops at `isAdult adult`, which fails
      // first but is not selected, so `isAdult child` runs again without it.
      const result = await session.runMutant(find('age >= 18', 'age < 18').key, [`${T}#isAdult child`], { timeoutMs: 10_000, isStatic: true });
      expect(result).toMatchObject({ status: 'Killed', killedBy: [`${T}#isAdult child`] });
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
      const [first, plain, once] = ['test/scheme.test.ts#first', 'test/scheme.test.ts#plain', 'test/once.test.ts#once'];
      expect(dry.tests.map((t) => t.id)).toEqual([once, first, id, plain]);
      const mutant = session.mutants().find((m) => m.original === "input.startsWith('\\0')" && m.replacement === 'false')!;
      expect(dry.coverage.get(mutant.key)).toEqual([first, id, plain]);
      // The pattern misses the test named with a NUL, so its file runs again whole. There,
      // `first` fails too but is not selected: --bail must not stop the run at it.
      const result = await session.runMutant(mutant.key, [id, plain], { timeoutMs: 10_000 });
      expect(result).toMatchObject({ status: 'Killed', killedBy: [id] });
      // Without early exit (kill matrix), the rerun also follows a selected test that failed.
      const all = await session.runMutant(mutant.key, [first, id], { timeoutMs: 10_000, earlyExit: false });
      expect(all).toMatchObject({ status: 'Killed', killedBy: [first, id] });
      // A selected test that failed in the first run still counts when it passes in the rerun.
      process.env.MUTATOR_TEST_ONCE = join(mkdtempSync(join(tmpdir(), 'mutator-bun-once-')), 'marker');
      const flaky = await session.runMutant('no-such-mutant', [once, id], { timeoutMs: 10_000, earlyExit: false });
      expect(flaky).toMatchObject({ status: 'Killed', killedBy: [once] });
      expect(existsSync(process.env.MUTATOR_TEST_ONCE)).toBe(true);
    } finally {
      if (process.env.MUTATOR_TEST_ONCE) rmSync(dirname(process.env.MUTATOR_TEST_ONCE), { recursive: true, force: true });
      delete process.env.MUTATOR_TEST_ONCE;
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
      // Also after an earlier file finished and wrote its record.
      const later = await session.runMutant(mutant.key, ['test/early.test.ts#first', 'test/guard.test.ts#check'], { timeoutMs: 10_000 });
      expect(later.status).toBe('RuntimeError');
    } finally {
      await session.close();
    }
  });

  test('sessions share instrumented sources only with the same plugin objects', async () => {
    const root = fixture('matrix');
    const targets = [join(root, 'src/add.ts')];
    const all = { name: 'all', shouldIgnore: () => 'everything' };
    const none = { name: 'none', shouldIgnore: () => undefined };
    const sessions = await Promise.all([all, none, all].map((ignorer) => createBunSession({ root, targets, ignorers: [ignorer] })));
    try {
      expect(sessions[2]!.mutants()).toBe(sessions[0]!.mutants());
      expect(sessions[1]!.mutants()).not.toBe(sessions[0]!.mutants());
    } finally {
      await Promise.all(sessions.map((s) => s.close()));
    }
  });

  test('a target that fails to instrument leaves no sources behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mutator-bun-broken-'));
    // A temporary directory of its own: other test files create sources at the same time.
    const temp = join(root, 'tmp');
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(temp);
      writeFileSync(join(root, 'src/broken.ts'), 'export const x = (;\n');
      Object.assign(process.env, { TMPDIR: temp, TEMP: temp, TMP: temp });
      await expect(createBunSession({ root, targets: [join(root, 'src/broken.ts')] })).rejects.toThrow('Failed to parse');
      expect(readdirSync(temp)).toEqual([]);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
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
