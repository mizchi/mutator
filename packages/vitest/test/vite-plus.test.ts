import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createSession } from '../src/session.ts';

const root = fileURLToPath(new URL('./fixtures/vite-plus', import.meta.url));
const slash = (path: string) => path.replaceAll('\\', '/');
const testId = (title: string) => `${join('test', 'math.test.ts')}#${title}`;

test.each([1, 2])('Vite+ config and imports support coverage and mutant runs across sessions (run %i)', { timeout: 30_000 }, async () => {
  const session = await createSession({ root, include: (file) => file.startsWith(join(root, 'src') + sep), maxWorkers: 1 });
  try {
    expect((await session.testFiles()).map(slash)).toEqual([slash(join(root, 'test', 'math.test.ts'))]);
    expect(session.configFiles().map(slash)).toContain(slash(join(root, 'vite.config.ts')));
    const dry = await session.dryRun();
    expect(dry.failed).toEqual([]);
    expect(dry.tests.map((test) => test.id)).toEqual([
      testId('add'), testId('adult'), testId('limit'),
    ]);
    const find = (original: string, replacement: string) => {
      const mutant = session.mutants().find((m) => m.original === original && m.replacement === replacement);
      expect(mutant).toBeDefined();
      return mutant!.key;
    };
    const addition = find('a + b', 'a - b');
    expect(dry.coverage.get(addition)).toEqual([testId('add')]);
    expect(await session.runMutant(addition, dry.coverage.get(addition)!, { timeoutMs: 10_000 }))
      .toMatchObject({ status: 'Killed', killedBy: [testId('add')] });

    const boundary = find('age >= 18', 'age > 18');
    expect(await session.runMutant(boundary, dry.coverage.get(boundary)!, { timeoutMs: 10_000 }))
      .toMatchObject({ status: 'Survived', killedBy: [] });

    const limit = find('10 * 2', '10 / 2');
    expect(dry.staticKeys.has(limit)).toBe(true);
    expect(await session.runMutant(limit, [testId('limit')], { timeoutMs: 10_000, isStatic: true }))
      .toMatchObject({ status: 'Killed', killedBy: [testId('limit')] });
  } finally {
    await session.close();
  }
});
