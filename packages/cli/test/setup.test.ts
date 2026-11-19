import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { listMutants } from '../src/run.ts';
import { resolveSetup } from '../src/setup.ts';

describe('include / exclude expansion', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mutator-setup-'));
    mkdirSync(join(root, 'src/domain/repository'), { recursive: true });
    mkdirSync(join(root, 'src/usecase'), { recursive: true });
    writeFileSync(join(root, 'src/domain/user.ts'), 'export const isAdult = (age: number) => age >= 18;\n');
    writeFileSync(join(root, 'src/domain/repository/user-repository.ts'), 'export const limit = (n: number) => n > 10;\n');
    writeFileSync(join(root, 'src/domain/repository/types.d.ts'), 'export type Id = string;\n');
    writeFileSync(join(root, 'src/domain/user.test.ts'), 'export {};\n');
    writeFileSync(join(root, 'src/domain/README.md'), '# domain\n');
    writeFileSync(join(root, 'src/domain/data.json'), '{}\n');
    writeFileSync(join(root, 'src/usecase/run.ts'), 'export const run = (a: number) => a + 1;\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const targets = async (include: string[], exclude?: string[]) => {
    const { files } = await resolveSetup(root, { root, runner: 'vitest', include, ...(exclude ? { exclude } : {}) }, () => {});
    return files.map((f) => f.slice(root.length + 1).replaceAll('\\', '/')).sort();
  };

  test('`dir/**` yields the source files under it, not its directories', async () => {
    expect(await targets(['src/domain/**'])).toEqual(['src/domain/repository/user-repository.ts', 'src/domain/user.ts']);
  });

  test('`dir/**` with a nested directory lists mutants without reading a directory', async () => {
    const mutants = await listMutants({ root, runner: 'vitest', include: ['src/usecase/**', 'src/domain/**'] });
    expect(new Set(mutants.map((m) => relative(realpathSync.native(root), m.file).replaceAll('\\', '/')))).toEqual(
      new Set(['src/usecase/run.ts', 'src/domain/user.ts', 'src/domain/repository/user-repository.ts']),
    );
  });

  test('`dir/**` in exclude removes the files under it', async () => {
    expect(await targets(['src/**'], ['src/domain/repository/**'])).toEqual(['src/domain/user.ts', 'src/usecase/run.ts']);
  });
});
