import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createSession } from '../src/session.ts';

test.each([false, true])('changing include sets never reuses uninstrumented transforms (inline project: %s)', { timeout: 30_000 }, async (project) => {
  const parent = fileURLToPath(new URL('../../../.tmp', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'module-cache-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'src/a.ts'), 'export const a = (n: number) => n + 1;\n');
    writeFileSync(join(root, 'src/b.ts'), 'export const b = (n: number) => n * 2;\n');
    for (const name of ['a', 'b']) writeFileSync(join(root, `test/${name}.test.ts`), `import { test, expect } from 'vitest';\nimport { ${name} } from '../src/${name}.ts';\ntest('${name}', () => expect(${name}(2)).toBe(${name === 'a' ? 3 : 4}));\n`);
    const cache = { fsModuleCache: true, fsModuleCachePath: join(root, '.transform-cache') };
    const config = project ? { test: { ...cache, projects: [{ root, test: { ...cache, name: 'unit', include: ['test/**/*.test.ts'] } }] } } : { test: { ...cache, include: ['test/**/*.test.ts'] } };
    writeFileSync(join(root, 'vitest.config.ts'), `export default ${JSON.stringify(config)};\n`);
    for (const selected of ['a', 'b', undefined]) {
      const session = await createSession({ root, include: (file) => selected ? file === join(root, `src/${selected}.ts`) : file.startsWith(join(root, 'src') + sep) });
      try {
        const dry = await session.dryRun();
        expect(dry.failed).toEqual([]);
        for (const name of selected ? [selected] : ['a', 'b']) {
          const operator = name === 'a' ? 'n + 1' : 'n * 2';
          const mutant = session.mutants().find((m) => m.original === operator);
          expect(mutant, name).toBeDefined();
          const covering = dry.coverage.get(mutant!.key);
          expect(covering?.length, name).toBeGreaterThan(0);
          expect(await session.runMutant(mutant!.key, covering!, { timeoutMs: 10_000 })).toMatchObject({ status: 'Killed' });
        }
      } finally { await session.close(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
