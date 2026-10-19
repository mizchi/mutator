import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@mizchi/mutator-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createJestSession } from '../src/session.ts';

const root = fileURLToPath(new URL('./fixtures/esm', import.meta.url));
const T = '__tests__/math.test.js';

describe('jest session: child processes', { timeout: 60_000 }, () => {
  test('the dry run records the processes each test starts', async () => {
    const spawnRoot = fileURLToPath(new URL('./fixtures/spawn', import.meta.url));
    const session = await createJestSession({ root: spawnRoot, targets: [join(spawnRoot, 'src/cli.js')] });
    try {
      const dry = await session.dryRun();
      expect(dry.failed).toEqual([]);
      expect(Object.fromEntries(dry.spawns ?? [])).toEqual({ '__tests__/cli.test.js#greets': [{ argv: ['node', 'src/cli.js'], cwd: spawnRoot }] });
    } finally {
      await session.close();
    }
  });
});

test('a test writing megabytes to stdout does not block the run (stdout is not piped)', { timeout: 60_000 }, async () => {
  const noisyRoot = fileURLToPath(new URL('./fixtures/noisy', import.meta.url));
  const session = await createJestSession({ root: noisyRoot, targets: [join(noisyRoot, 'src/double.js')] });
  try {
    const dry = await session.dryRun();
    expect(dry.tests.map((t) => t.id)).toEqual(['__tests__/noisy.test.js#double']);
    const mutant = session.mutants().find((m) => m.original === 'n * 2' && m.replacement === 'n / 2')!;
    expect(await session.runMutant(mutant.key, ['__tests__/noisy.test.js#double'], { timeoutMs: 20_000 })).toMatchObject({ status: 'Killed' });
  } finally {
    await session.close();
  }
});

describe('jest session: a mutant failing several test files', { timeout: 60_000 }, () => {
  const matrixRoot = fileURLToPath(new URL('./fixtures/matrix', import.meta.url));
  const A = '__tests__/a.test.js#a';
  const B = '__tests__/b.test.js#b';
  let session: Session;
  let key: string;
  let tests: string[];
  beforeAll(async () => {
    session = await createJestSession({ root: matrixRoot, targets: [join(matrixRoot, 'src/add.js')] });
    const dry = await session.dryRun();
    key = session.mutants().find((m) => m.original === 'a + b' && m.replacement === 'a - b')!.key;
    tests = dry.coverage.get(key)!;
  });
  afterAll(async () => {
    await session?.close();
  });

  test('both test files cover it', () => {
    expect([...tests].sort()).toEqual([A, B]);
  });

  test('with early exit it is killed by the first failing test (#13)', async () => {
    // Jest's --bail exits the process before writing the --json report when a file is left.
    const result = await session.runMutant(key, tests, { timeoutMs: 10_000 });
    expect(result.status).toBe('Killed');
    expect(result.killedBy).toHaveLength(1);
    expect([A, B]).toContain(result.killedBy[0]);
  });

  test('without early exit every failing test file runs (kill matrix)', async () => {
    const all = await session.runMutant(key, tests, { timeoutMs: 10_000, earlyExit: false });
    expect(all.status).toBe('Killed');
    expect([...all.killedBy].sort()).toEqual([A, B]);
  });
});

describe('jest session: a run that ends before the --json report', { timeout: 60_000 }, () => {
  // a.test.js is the slowest file, so Jest runs it first and it has passed before b or c ends
  // the run; b and c each have a test that passes besides the one the mutant breaks.
  const bailRoot = fileURLToPath(new URL('./fixtures/bail', import.meta.url));
  const A = '__tests__/a.test.js#a';
  const file = (name: string) => [`__tests__/${name}.test.js#${name} ok`, `__tests__/${name}.test.js#${name} add`, `__tests__/${name}.test.js#${name} exit`];
  let session: Session;
  const find = (original: string, replacement: string) => session.mutants().find((m) => m.original === original && m.replacement === replacement)!;
  beforeAll(async () => {
    session = await createJestSession({ root: bailRoot, targets: [join(bailRoot, 'src/app.js')] });
    expect((await session.dryRun()).failed).toEqual([]);
  });
  afterAll(async () => {
    await session?.close();
  });

  test('the failure that made Jest bail kills the mutant, next to passed tests and files', async () => {
    const result = await session.runMutant(find('a + b', 'a - b').key, [A, ...file('b'), ...file('c')], { timeoutMs: 10_000 });
    expect(result.status).toBe('Killed');
    expect(result.killedBy).toHaveLength(1);
    expect(['__tests__/b.test.js#b add', '__tests__/c.test.js#c add']).toContain(result.killedBy[0]);
  });

  test('a run that exits without a failed test is a runtime error', async () => {
    const started = performance.now();
    const result = await session.runMutant(find('code !== 0', 'code === 0').key, [A, ...file('b'), ...file('c')], { timeoutMs: 10_000 });
    const elapsed = performance.now() - started;
    expect(result).toEqual({ status: 'RuntimeError', killedBy: [], durationMs: expect.any(Number) });
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.durationMs).toBeLessThanOrEqual(elapsed);
  });
});

test('a mutant that breaks loading several test files is a runtime error', { timeout: 60_000 }, async () => {
  const loadRoot = fileURLToPath(new URL('./fixtures/loaderror', import.meta.url));
  const session = await createJestSession({ root: loadRoot, targets: [join(loadRoot, 'src/config.js')] });
  try {
    const dry = await session.dryRun();
    expect(dry.failed).toEqual([]);
    const mutant = session.mutants().find((m) => m.original === '2 + 1' && m.replacement === '2 - 1')!;
    const tests = ['__tests__/a.test.js#a', '__tests__/b.test.js#b'];
    for (const earlyExit of [true, false]) {
      const result = await session.runMutant(mutant.key, tests, { timeoutMs: 10_000, isStatic: true, earlyExit });
      expect(result.status).toBe('RuntimeError');
      expect([...result.killedBy].sort()).toEqual(['__tests__/a.test.js', '__tests__/b.test.js']);
    }
  } finally {
    await session.close();
  }
});

describe('jest session (ESM fixture)', { timeout: 60_000 }, () => {
  let session: Session;
  beforeAll(async () => {
    session = await createJestSession({ root, targets: [join(root, 'src/math.js')] });
  });
  afterAll(async () => {
    await session?.close();
  });

  const find = (original: string, replacement: string) => {
    const m = session.mutants().find((m) => m.original === original && m.replacement === replacement);
    if (!m) throw new Error(`mutant ${original} -> ${replacement} not found`);
    return m;
  };

  test('lists test files and config files', async () => {
    expect(await session.testFiles()).toEqual([join(root, T)]);
    expect(session.configFiles()).toEqual([join(root, 'jest.config.js')]);
  });

  test('dry run collects tests, per-test coverage and static coverage', async () => {
    const dry = await session.dryRun();
    expect(dry.failed).toEqual([]);
    expect(dry.tests.map((t) => t.id)).toEqual([`${T}#add`, `${T}#isAdult adult`, `${T}#isAdult child`, `${T}#limit`, `${T}#countdown`]);
    expect(dry.tests.every((t) => t.fingerprint.length > 0 && t.durationMs >= 0)).toBe(true);
    expect(dry.coverage.get(find('a + b', 'a - b').key)).toEqual([`${T}#add`]);
    expect(dry.coverage.get(find('age >= 18', 'age > 18').key)).toEqual([`${T}#isAdult adult`, `${T}#isAdult child`]);
    expect(dry.coverage.get(find('x * 3', 'x / 3').key) ?? []).toEqual([]);
    expect(dry.staticKeys.has(find('10 * 2', '10 / 2').key)).toBe(true);
    expect(dry.staticByFile.get(T)?.has(find('10 * 2', '10 / 2').key)).toBe(true);
    expect(dry.hits.get(find('a + b', 'a - b').key)).toBe(1);
    expect(dry.index.get(`${T}#isAdult adult`)).toEqual({ moduleId: join(root, T), taskId: 'isAdult adult' });
  });

  test('a covered mutant is killed by the covering test', async () => {
    const result = await session.runMutant(find('a + b', 'a - b').key, [`${T}#add`], { timeoutMs: 10_000 });
    expect(result.status).toBe('Killed');
    expect(result.killedBy).toEqual([`${T}#add`]);
  });

  test('a boundary mutant survives', async () => {
    const result = await session.runMutant(find('age >= 18', 'age > 18').key, [`${T}#isAdult adult`, `${T}#isAdult child`], { timeoutMs: 10_000 });
    expect(result.status).toBe('Survived');
    expect(result.killedBy).toEqual([]);
  });

  test('static mutants are active while the module loads', async () => {
    const result = await session.runMutant(find('10 * 2', '10 / 2').key, [`${T}#limit`], { timeoutMs: 10_000, isStatic: true });
    expect(result.status).toBe('Killed');
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
});

test('a second session reuses the dry-run index', { timeout: 60_000 }, async () => {
  const targets = [join(root, 'src/math.js')];
  const a = await createJestSession({ root, targets });
  const b = await createJestSession({ root, targets });
  try {
    const dry = await a.dryRun();
    b.useTestIndex(dry.index);
    const key = a.mutants().find((m) => m.original === 'a + b' && m.replacement === 'a - b')!.key;
    expect((await b.runMutant(key, [`${T}#add`], { timeoutMs: 10_000 })).status).toBe('Killed');
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test('target files are instrumented before the project transformer runs', { timeout: 60_000 }, async () => {
  const innerRoot = fileURLToPath(new URL('./fixtures/inner', import.meta.url));
  const session = await createJestSession({ root: innerRoot, targets: [join(innerRoot, 'src/value.js')] });
  try {
    const dry = await session.dryRun();
    expect(dry.failed).toEqual([]);
    const mutant = session.mutants().find((m) => m.original === '__VALUE__ * 2' && m.replacement === '__VALUE__ / 2')!;
    expect(dry.coverage.get(mutant.key)).toEqual(['test/value.test.js#double']);
    expect((await session.runMutant(mutant.key, ['test/value.test.js#double'], { timeoutMs: 10_000 })).status).toBe('Killed');
  } finally {
    await session.close();
  }
});

describe('jest session (ESM + TypeScript, types stripped by Node)', { timeout: 60_000 }, () => {
  const tsRoot = fileURLToPath(new URL('./fixtures/ts', import.meta.url));
  const TS = 'test/math.test.ts';

  test('dry run and verdicts', async () => {
    const session = await createJestSession({ root: tsRoot, targets: [join(tsRoot, 'src/math.ts')] });
    try {
      const find = (original: string, replacement: string) => session.mutants().find((m) => m.original === original && m.replacement === replacement)!;
      const dry = await session.dryRun();
      expect(dry.failed).toEqual([]);
      expect(dry.tests.map((t) => t.id)).toEqual([`${TS}#add`, `${TS}#isAdult adult`, `${TS}#isAdult child`, `${TS}#limit`]);
      expect(dry.coverage.get(find('a + b', 'a - b').key)).toEqual([`${TS}#add`]);
      expect(dry.staticKeys.has(find('10 * 2', '10 / 2').key)).toBe(true);
      expect((await session.runMutant(find('a + b', 'a - b').key, [`${TS}#add`], { timeoutMs: 10_000 })).status).toBe('Killed');
      const boundary = find('person.age >= 18', 'person.age > 18').key;
      expect((await session.runMutant(boundary, dry.coverage.get(boundary)!, { timeoutMs: 10_000 })).status).toBe('Survived');
    } finally {
      await session.close();
    }
  });
});

