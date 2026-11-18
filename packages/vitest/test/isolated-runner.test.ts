import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createSession } from '../src/session.ts';

// Some projects keep Vitest in a sibling directory so that its dependencies never reach the
// project's own build toolchain, and point at that directory's config (`vitestConfig`).
// The project root, outside this repository, cannot resolve vitest; the config directory can.
test('runs a project whose Vitest is installed only next to its config file', { timeout: 30_000 }, async () => {
  // Native realpath: tmpdir() is a symlink on macOS (/tmp) and an 8.3 short path on Windows runners.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mutator-isolated-root-')));
  const parent = fileURLToPath(new URL('../../../.tmp', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const runner = mkdtempSync(join(parent, 'isolated-runner-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'src/a.ts'), 'export const a = (n: number) => n + 1;\n');
    writeFileSync(join(root, 'test/a.test.ts'), "import { a } from '../src/a.ts';\ntest('a', () => expect(a(2)).toBe(3));\n");
    const configFile = join(runner, 'vitest.config.ts');
    writeFileSync(configFile, `export default ${JSON.stringify({ test: { globals: true, include: ['test/**/*.test.ts'] } })};\n`);
    const session = await createSession({ root, configFile, include: (file) => file.startsWith(join(root, 'src') + sep) });
    try {
      const dry = await session.dryRun();
      expect(dry.failed).toEqual([]);
      const mutant = session.mutants().find((m) => m.original === 'n + 1');
      expect(mutant).toBeDefined();
      const covering = dry.coverage.get(mutant!.key);
      expect(covering?.length).toBeGreaterThan(0);
      expect(await session.runMutant(mutant!.key, covering!, { timeoutMs: 10_000 })).toMatchObject({ status: 'Killed' });
    } finally { await session.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runner, { recursive: true, force: true });
  }
});
