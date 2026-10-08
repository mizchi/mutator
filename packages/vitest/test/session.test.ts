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
