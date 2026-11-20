import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { checkInWorker, createTypeChecker } from '../src/index.ts';
import type { TypecheckMutant } from '../src/types.ts';

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

/** In `root`'s copy of the fixture: `bad` breaks the return type of `len`, `fine` does not, `eq` is proven equivalent. */
function mutantsIn(root: string): Record<'bad' | 'fine' | 'eq', TypecheckMutant> {
  const file = join(root, 'src/a.ts');
  const start = readFileSync(file, 'utf8').indexOf('s.length');
  const chain = join(root, 'src/chain.ts');
  const at = readFileSync(chain, 'utf8').indexOf('box?.value') + 3;
  return {
    bad: { key: 'bad', file, range: { start, end: start + 8 }, replacement: '"x"' },
    fine: { key: 'fine', file, range: { start, end: start + 8 }, replacement: '0' },
    eq: { key: 'eq', file: chain, range: { start: at, end: at + 2 }, replacement: '.' },
  };
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
      const { bad, fine } = mutantsIn(root);
      expect([...checker!.check([bad, fine]).keys()]).toEqual(['bad']);
    } finally {
      checker!.close();
    }
  });

  test('falls back to Bun\'s checker without typescript', async () => {
    // Outside the workspace, whose own typescript would resolve.
    const root = mkdtempSync(join(tmpdir(), 'tc-bun-'));
    roots.push(root);
    cpSync(fixture, root, { recursive: true });
    const checker = await createTypeChecker({ root });
    expect(checker?.version).toMatch(/^7\.\d+\.\d+ via bun check$/);
    try {
      const { bad, fine } = mutantsIn(root);
      expect([...checker!.check([bad, fine]).keys()]).toEqual(['bad']);
    } finally {
      checker!.close();
    }
  });

  test.each([
    ['typescript7', /^7\.\d+\.\d+ via bun check$/],
    ['typescript6', /^6\./],
  ] as const)('with preferBun, Bun finds the type errors only for its own TypeScript major (%s)', async (alias, version) => {
    const root = projectWith(alias);
    const checker = await createTypeChecker({ root, preferBun: true });
    try {
      expect(checker!.version).toMatch(version);
      const { bad, fine, eq } = mutantsIn(root);
      expect([...checker!.check([bad, fine]).keys()]).toEqual(['bad']);
      // Bun proves no equivalences: they still come from the project's TypeScript.
      expect(checker!.equivalent([eq])).toEqual(new Map([['eq', 'equivalent: box is never nullish']]));
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

describe('checkInWorker', () => {
  test.each([
    [false, /^7\.\d+\.\d+$/],
    [true, /^7\.\d+\.\d+ via bun check$/],
  ] as const)('checks off the main thread, reporting equivalences too (preferBun: %s)', async (preferBun, version) => {
    const root = projectWith('typescript7');
    const { bad, fine, eq } = mutantsIn(root);
    const checked = await checkInWorker({ root, preferBun }, [bad, fine, eq]);
    expect(checked?.version).toMatch(version);
    expect([...checked!.errors.keys()]).toEqual(['bad']);
    expect(checked?.equivalent).toEqual(new Map([['eq', 'equivalent: box is never nullish']]));
    expect(checked?.inputs.files).toContain(join(root, 'src/chain.ts'));
  });

  test('is undefined without typescript or tsconfig', async () => {
    const root = join(tmp, `tc-none-worker-${process.pid}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    expect(await checkInWorker({ root }, [])).toBeUndefined();
  });
});
