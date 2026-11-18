import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { listMutants, runMutation } from '../src/run.ts';

test('an aliased project root uses the same source paths as Vite', { timeout: 30_000 }, async () => {
  const parent = fileURLToPath(new URL('../../../.tmp', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, 'native-root-'));
  const root = join(work, 'project');
  const alias = join(work, 'alias');
  try {
    cpSync(fileURLToPath(new URL('../../vitest/test/fixtures/basic', import.meta.url)), root, { recursive: true });
    symlinkSync(realpathSync.native(root), alias, 'junction');
    const report = await runMutation({ root: alias, typecheck: false, concurrency: 1 });
    expect(report.noCoverage).toBeUndefined();
    expect(report.entries.find((entry) => entry.mutant.original === 'a + b' && entry.mutant.replacement === 'a - b')?.status).toBe('Killed');
    expect(new Set((await listMutants({ root: alias })).map((m) => m.key))).toEqual(new Set(report.entries.map((e) => e.mutant.key)));
    expect((await runMutation({ root: realpathSync.native(root), typecheck: false, concurrency: 1 })).executed).toBe(0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
