import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { type Session, createSession } from '../src/session.ts';

describe('native path separators', () => {
  // On Windows, `join` gives `D:\repo\src\add.ts` while Vite module ids are `D:/repo/src/add.ts`.
  const pathsRoot = fileURLToPath(new URL('./fixtures/paths', import.meta.url));
  const source = join(pathsRoot, 'src', 'add.ts');
  const addTest = join(pathsRoot, 'test', 'add.test.ts');
  const findAdd = (session: Session) => session.mutants().find((m) => m.original === 'a + b' && m.replacement === 'a - b');
  // Test ids are relative paths, so their separator differs by OS; this suite is about module ids.
  const slash = (ids: string[] | undefined) => ids?.map((id) => id.replaceAll('\\', '/')).sort();

  test('an include that compares native paths selects the source', async () => {
    const session = await createSession({ root: pathsRoot, include: (file) => file === source });
    try {
      const dry = await session.dryRun();
      const mutant = findAdd(session);
      expect(mutant).toBeDefined();
      const covering = dry.coverage.get(mutant!.key);
      expect(slash(covering)).toEqual(['test/add.test.ts#add', 'test/other.test.ts#other']);
      const result = await session.runMutant(mutant!.key, covering!, { timeoutMs: 10_000 });
      expect(result.status).toBe('Killed');
    } finally {
      await session.close();
    }
  });

  test('a dry run limited to native test paths runs only those files', async () => {
    const session = await createSession({ root: pathsRoot, include: (file) => file.includes('/src/') });
    try {
      const dry = await session.dryRun([addTest]);
      expect(slash(dry.tests.map((t) => t.id))).toEqual(['test/add.test.ts#add']);
      expect(slash(dry.coverage.get(findAdd(session)!.key))).toEqual(['test/add.test.ts#add']);
      expect((await session.dryRun([])).tests).toEqual([]);
      expect(slash((await session.dryRun()).tests.map((t) => t.id))).toEqual(['test/add.test.ts#add', 'test/other.test.ts#other']);
    } finally {
      await session.close();
    }
  });

  test('a dry run does not match an undiscovered path by collapsing parent segments', async () => {
    const session = await createSession({ root: pathsRoot, include: () => false });
    try {
      const undiscoveredPath = `${pathsRoot}/missing/../test/add.test.ts`;
      expect((await session.dryRun([undiscoveredPath])).tests).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
