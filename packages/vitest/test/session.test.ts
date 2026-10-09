import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type Session, createSession } from '../src/session.ts';

const root = fileURLToPath(new URL('./fixtures/basic', import.meta.url));

describe('vitest session', () => {
  let session: Session;
  beforeAll(async () => {
    session = await createSession({ root, include: (file) => file.includes('/src/') });
  });
  afterAll(async () => {
    await session?.close();
  });

  const find = (original: string, replacement: string) => {
    const m = session.mutants().find((m) => m.original === original && m.replacement === replacement);
    if (!m) throw new Error(`mutant ${original} -> ${replacement} not found`);
    return m;
  };

  test('dry run collects tests, per-test coverage and static coverage', async () => {
    const dry = await session.dryRun();
    expect(dry.failed).toEqual([]);
    expect(dry.tests.map((t) => t.id)).toEqual([
      'test/math.test.ts#add',
      'test/math.test.ts#isAdult > adult',
      'test/math.test.ts#isAdult > child',
      'test/math.test.ts#limit',
    ]);
    expect(dry.tests.every((t) => t.fingerprint.length > 0 && t.durationMs >= 0)).toBe(true);
    expect(dry.coverage.get(find('a + b', 'a - b').key)).toEqual(['test/math.test.ts#add']);
    expect(dry.coverage.get(find('age >= 18', 'age > 18').key)).toEqual([
      'test/math.test.ts#isAdult > adult',
      'test/math.test.ts#isAdult > child',
    ]);
    expect(dry.coverage.get(find('x * 3', 'x / 3').key) ?? []).toEqual([]);
    expect(dry.staticKeys.has(find('10 * 2', '10 / 2').key)).toBe(true);
  });

  test('a covered mutant is killed by the covering test', async () => {
    const result = await session.runMutant(find('a + b', 'a - b').key, ['test/math.test.ts#add'], { timeoutMs: 10_000 });
    expect(result.status).toBe('Killed');
    expect(result.killedBy).toEqual(['test/math.test.ts#add']);
  });

  test('a boundary mutant survives', async () => {
    const tests = ['test/math.test.ts#isAdult > adult', 'test/math.test.ts#isAdult > child'];
    const result = await session.runMutant(find('age >= 18', 'age > 18').key, tests, { timeoutMs: 10_000 });
    expect(result.status).toBe('Survived');
    expect(result.killedBy).toEqual([]);
  });

  test('static mutants are activated before module evaluation', async () => {
    const result = await session.runMutant(find('10 * 2', '10 / 2').key, ['test/math.test.ts#limit'], { timeoutMs: 10_000, isStatic: true });
    expect(result.status).toBe('Killed');
  });

  test('only the selected tests run', async () => {
    // `a - b` is killed by `add`, but `add` is not selected.
    const result = await session.runMutant(find('a + b', 'a - b').key, ['test/math.test.ts#limit'], { timeoutMs: 10_000 });
    expect(result.status).toBe('Survived');
  });
});

describe('parallel sessions', () => {
  test('a second session reuses the dry-run index and gives the same verdicts', async () => {
    const include = (file: string) => file.includes('/src/');
    const [a, b] = await Promise.all([createSession({ root, include }), createSession({ root, include, maxWorkers: 1 })]);
    try {
      const dry = await a.dryRun();
      b.useTestIndex(dry.index);
      const key = a.mutants().find((m) => m.original === 'a + b' && m.replacement === 'a - b')!.key;
      const boundary = a.mutants().find((m) => m.original === 'age >= 18' && m.replacement === 'age > 18')!.key;
      const [killed, survived] = await Promise.all([
        b.runMutant(key, ['test/math.test.ts#add'], { timeoutMs: 10_000 }),
        a.runMutant(boundary, dry.coverage.get(boundary)!, { timeoutMs: 10_000 }),
      ]);
      expect(killed.status).toBe('Killed');
      expect(survived.status).toBe('Survived');
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});

describe('determinism', () => {
  test('a mutant killed in many files is killed on every repetition', { timeout: 120_000 }, async () => {
    const manyRoot = fileURLToPath(new URL('./fixtures/many', import.meta.url));
    const session = await createSession({ root: manyRoot, include: (file) => file.includes('/src/') });
    try {
      const dry = await session.dryRun();
      const mutant = session.mutants().find((m) => m.original === 'a + b' && m.replacement === 'a - b')!;
      const tests = dry.coverage.get(mutant.key)!;
      expect(tests).toHaveLength(6);
      const verdicts: string[] = [];
      for (let i = 0; i < 10; i++) {
        verdicts.push((await session.runMutant(mutant.key, tests, { timeoutMs: 30_000 })).status);
      }
      expect(verdicts).toEqual(Array(10).fill('Killed'));

      // A cancelled (early-exited) run must not leak into the next one.
      const survivor = session.mutants().find((m) => m.original === 'x >= 0' && m.replacement === 'x > 0')!;
      const alternating: string[] = [];
      for (let i = 0; i < 5; i++) {
        alternating.push((await session.runMutant(mutant.key, tests, { timeoutMs: 30_000 })).status);
        alternating.push((await session.runMutant(survivor.key, dry.coverage.get(survivor.key)!, { timeoutMs: 30_000 })).status);
      }
      expect(alternating).toEqual(Array(5).fill(['Killed', 'Survived']).flat());
    } finally {
      await session.close();
    }
  });
});

describe('early exit inside a test file', () => {
  test('stops at the first failing test of the file', async () => {
    const earlyRoot = fileURLToPath(new URL('./fixtures/early', import.meta.url));
    const session = await createSession({ root: earlyRoot, include: (file) => file.includes('/src/') });
    try {
      const dry = await session.dryRun();
      const mutant = session.mutants().find((m) => m.original === 'a + b' && m.replacement === 'a - b')!;
      const tests = dry.coverage.get(mutant.key)!;
      expect(tests).toHaveLength(30);
      const result = await session.runMutant(mutant.key, tests, { timeoutMs: 30_000 });
      expect(result.status).toBe('Killed');
      expect(result.killedBy).toEqual(['test/m.test.ts#add 1']);
    } finally {
      await session.close();
    }
  });
});

describe('edge cases', () => {
  const edgeRoot = fileURLToPath(new URL('./fixtures/edge', import.meta.url));
  let session: Session;
  let dry: Awaited<ReturnType<Session['dryRun']>>;
  beforeAll(async () => {
    session = await createSession({ root: edgeRoot, include: (file) => file.includes('/edge/src/') });
    dry = await session.dryRun();
  });
  afterAll(async () => {
    await session?.close();
  });

  const find = (file: string, original: string, replacement: string) => {
    const m = session.mutants().find((m) => m.file.endsWith(file) && m.original === original && m.replacement === replacement);
    if (!m) throw new Error(`mutant ${original} -> ${replacement} not found`);
    return m;
  };
  const isPosFalse = () => find('sign.ts', 'x > 0', 'false').key;

  test('concurrent tests are all credited with coverage', async () => {
    expect(dry.failed).toEqual([]);
    const covering = dry.coverage.get(isPosFalse())!;
    const concurrent = covering.filter((id) => id.startsWith('test/concurrent.test.ts')).sort();
    expect(concurrent).toEqual(['test/concurrent.test.ts#neg', 'test/concurrent.test.ts#pos']);
    const result = await session.runMutant(isPosFalse(), concurrent, { timeoutMs: 10_000 });
    expect(result.status).toBe('Killed');
    expect(result.killedBy).toEqual(['test/concurrent.test.ts#pos']);
  });

  test('a duplicate test name is reported with its own id', async () => {
    const result = await session.runMutant(isPosFalse(), ['test/dupes.test.ts#case', 'test/dupes.test.ts#case#2'], { timeoutMs: 10_000 });
    expect(result.status).toBe('Killed');
    expect(result.killedBy).toEqual(['test/dupes.test.ts#case#2']);
  });

  test('hitting the hit limit is a timeout', async () => {
    const result = await session.runMutant(find('spin.ts', 'i--', 'i++').key, ['test/spin.test.ts#countdown'], { timeoutMs: 10_000, hitLimit: 1000 });
    expect(result.status).toBe('Timeout');
  });

  test('verdicts after a timeout are not affected by the stuck run', async () => {
    const spin = find('spin.ts', 'i--', 'i++').key;
    const timedOut = await session.runMutant(spin, ['test/spin.test.ts#countdown'], { timeoutMs: 500, hitLimit: Number.MAX_SAFE_INTEGER });
    expect(timedOut.status).toBe('Timeout');
    const boundary = find('sign.ts', 'x > 0', 'x >= 0').key;
    const survived = await session.runMutant(boundary, dry.coverage.get(boundary)!, { timeoutMs: 10_000 });
    expect(survived.status).toBe('Survived');
    const killed = await session.runMutant(isPosFalse(), ['test/dupes.test.ts#case#2'], { timeoutMs: 10_000 });
    expect(killed).toMatchObject({ status: 'Killed', killedBy: ['test/dupes.test.ts#case#2'] });
  });
});

describe('process hygiene', () => {
  const descendants = (): number[] => {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(([, , comm]) => !comm?.endsWith('ps')) // the `ps` listing itself
      .map(([pid, ppid]) => [Number(pid), Number(ppid)] as [number, number]);
    const out: number[] = [];
    const walk = (pid: number) => {
      for (const [child, parent] of rows) if (parent === pid && child !== pid) out.push(child), walk(child);
    };
    walk(process.pid);
    return out;
  };

  test('a timed-out (infinite loop) run leaves no process behind after close', { timeout: 60_000 }, async () => {
    const before = new Set(descendants());
    const edgeRoot = fileURLToPath(new URL('./fixtures/edge', import.meta.url));
    const session = await createSession({ root: edgeRoot, include: (file) => file.includes('/edge/src/') });
    await session.dryRun();
    const spin = session.mutants().find((m) => m.file.endsWith('spin.ts') && m.original === 'i--' && m.replacement === 'i++')!;
    const result = await session.runMutant(spin.key, ['test/spin.test.ts#countdown'], { timeoutMs: 500, hitLimit: Number.MAX_SAFE_INTEGER });
    expect(result.status).toBe('Timeout');
    await session.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(descendants().filter((pid) => !before.has(pid))).toEqual([]);
  });

  test('a timed-out worker stuck in a loop stops burning CPU', { timeout: 60_000 }, async () => {
    const edgeRoot = fileURLToPath(new URL('./fixtures/edge', import.meta.url));
    const session = await createSession({ root: edgeRoot, include: (file) => file.includes('/edge/src/') });
    try {
      await session.dryRun();
      const spin = session.mutants().find((m) => m.file.endsWith('spin.ts') && m.original === 'i--' && m.replacement === 'i++')!;
      const result = await session.runMutant(spin.key, ['test/spin.test.ts#countdown'], { timeoutMs: 500, hitLimit: Number.MAX_SAFE_INTEGER });
      expect(result.status).toBe('Timeout');
      const before = process.cpuUsage();
      const started = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const used = process.cpuUsage(before);
      const share = (used.user + used.system) / 1000 / (performance.now() - started);
      expect(share).toBeLessThan(0.5);
    } finally {
      await session.close();
    }
  });
});

