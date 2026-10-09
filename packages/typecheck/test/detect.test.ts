import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { createTypeChecker } from '../src/index.ts';

const fixture = fileURLToPath(new URL('./fixtures/basic', import.meta.url));
const tmp = fileURLToPath(new URL('../../../.tmp', import.meta.url));
const require = createRequire(import.meta.url);
const roots: string[] = [];

function projectWith(alias: 'typescript6' | 'typescript7'): string {
  const root = join(tmp, `tc-${alias}-${process.pid}`);
  roots.push(root);
  rmSync(root, { recursive: true, force: true });
  cpSync(fixture, root, { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(dirname(require.resolve(`${alias}/package.json`)), join(root, 'node_modules/typescript'));
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('createTypeChecker', () => {
  test.each([
    ['typescript6', /^6\./],
    ['typescript7', /^7\./],
  ] as const)('uses the project typescript (%s)', async (alias, version) => {
    const root = projectWith(alias);
    const checker = await createTypeChecker({ root });
    expect(checker).toBeDefined();
    try {
      expect(checker!.version).toMatch(version);
      const file = join(root, 'src/a.ts');
      const source = readFileSync(file, 'utf8');
      const start = source.indexOf('s.length');
      const result = checker!.check([{ key: 'k', file, range: { start, end: start + 8 }, replacement: '"x"' }]);
      expect([...result.keys()]).toEqual(['k']);
    } finally {
      checker!.close();
    }
  });

  test('returns undefined without typescript or tsconfig', async () => {
    const root = join(tmp, `tc-none-${process.pid}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    expect(await createTypeChecker({ root })).toBeUndefined();
  });
});
