import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createSession } from '../src/session.ts';

const root = fileURLToPath(new URL('./fixtures/vite-plus', import.meta.url));

test.each([1, 2])('Vite+ config and imports support coverage and mutant runs across sessions (run %i)', { timeout: 30_000 }, async () => {
  const session = await createSession({ root, include: (file) => file.startsWith(`${root}/src/`), maxWorkers: 1 });
  try {
    expect(await session.testFiles()).toEqual([`${root}/test/math.test.ts`]);
    expect(session.configFiles()).toContain(`${root}/vite.config.ts`);
    const dry = await session.dryRun();
    expect(dry.failed).toEqual([]);
    expect(dry.tests.map((test) => test.id)).toEqual([
      'test/math.test.ts#add', 'test/math.test.ts#adult', 'test/math.test.ts#limit',
    ]);
    const find = (original: string, replacement: string) => {
      const mutant = session.mutants().find((m) => m.original === original && m.replacement === replacement);
      expect(mutant).toBeDefined();
      return mutant!.key;
    };
    const addition = find('a + b', 'a - b');
    expect(dry.coverage.get(addition)).toEqual(['test/math.test.ts#add']);
    expect(await session.runMutant(addition, dry.coverage.get(addition)!, { timeoutMs: 10_000 }))
      .toMatchObject({ status: 'Killed', killedBy: ['test/math.test.ts#add'] });

    const boundary = find('age >= 18', 'age > 18');
    expect(await session.runMutant(boundary, dry.coverage.get(boundary)!, { timeoutMs: 10_000 }))
      .toMatchObject({ status: 'Survived', killedBy: [] });

    const limit = find('10 * 2', '10 / 2');
    expect(dry.staticKeys.has(limit)).toBe(true);
    expect(await session.runMutant(limit, ['test/math.test.ts#limit'], { timeoutMs: 10_000, isStatic: true }))
      .toMatchObject({ status: 'Killed', killedBy: ['test/math.test.ts#limit'] });
  } finally {
    await session.close();
  }
});
