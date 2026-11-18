import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createSession } from '../src/session.ts';

const root = fileURLToPath(new URL('./fixtures/multi-project', import.meta.url));
const options = { root, include: (file: string) => file === join(root, 'src', 'math.ts'), maxWorkers: 1 };
const id = (project: string, name: string) => `test/math.test.ts#[${project}] ${name}`;

test('inline projects instrument sources and keep their setup and test identities', { timeout: 30_000 }, async () => {
  const session = await createSession(options);
  try {
    const dry = await session.dryRun();
    expect(dry.failed).toEqual([]);
    expect(dry.tests.map((t) => t.id).sort()).toEqual([id('unit', 'add'), id('integration', 'add'), id('unit', 'limit'), id('integration', 'limit')].sort());
    const addition = session.mutants().find((m) => m.original === 'a + b' && m.replacement === 'a - b');
    expect(addition).toBeDefined();
    expect(dry.coverage.get(addition!.key)?.sort()).toEqual([id('unit', 'add'), id('integration', 'add')].sort());
    expect(await session.runMutant(addition!.key, [id('integration', 'add')], { timeoutMs: 10_000 })).toMatchObject({ status: 'Killed', killedBy: [id('integration', 'add')] });
    expect(await session.runMutant(addition!.key, dry.coverage.get(addition!.key)!, { timeoutMs: 10_000, earlyExit: false })).toMatchObject({ status: 'Killed', killedBy: expect.arrayContaining([id('unit', 'add'), id('integration', 'add')]) });
    const limit = session.mutants().find((m) => m.original === '3 * 2' && m.replacement === '3 / 2');
    expect(limit).toBeDefined();
    expect(await session.runMutant(limit!.key, [id('integration', 'limit')], { timeoutMs: 10_000, isStatic: true })).toMatchObject({ status: 'Killed' });

    const other = await createSession(options);
    try {
      other.useTestIndex(dry.index);
      expect(await other.runMutant(addition!.key, [id('integration', 'add')], { timeoutMs: 10_000 })).toMatchObject({ status: 'Killed', killedBy: [id('integration', 'add')] });
    } finally { await other.close(); }
  } finally { await session.close(); }
});
