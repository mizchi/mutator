import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mutant, Session } from '@mizchi/mutator-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPlaywrightSession } from '../src/session.ts';

const fixture = fileURLToPath(new URL('./fixtures/app', import.meta.url));
// Inside this package, so the copy resolves @playwright/test, vite and this package itself.
const tmpRoot = fileURLToPath(new URL('../.tmp', import.meta.url));

describe('playwright session', { timeout: 120_000 }, () => {
  let root: string;
  let session: Session;
  let dry: Awaited<ReturnType<Session['dryRun']>>;
  const find = (file: string, original: string, replacement: string): Mutant => {
    const m = session.mutants().find((m) => m.file.endsWith(file) && m.original === original && m.replacement === replacement);
    if (!m) throw new Error(`no mutant ${original} -> ${replacement} in ${file}`);
    return m;
  };

  beforeAll(async () => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `app-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    process.env.MUTATOR_TEST_PORT = String(5300 + (process.pid % 400));
    session = await createPlaywrightSession({ root, targets: ['counter.ts', 'main.ts', 'other.ts'].map((f) => join(root, 'src', f)) });
    dry = await session.dryRun();
  });
  afterAll(async () => {
    await session?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('lists the test files', async () => {
    expect(await session.testFiles()).toEqual([join(root, 'tests/app.spec.ts')]);
  });

  test('the dry run records which test reached which mutant, across navigations', () => {
    expect(dry.tests.map((t) => t.id).sort()).toEqual(['tests/app.spec.ts#counter > increments', 'tests/app.spec.ts#navigates']);
    expect(dry.failed).toEqual([]);
    expect(dry.coverage.get(find('counter.ts', 'n + 1', 'n - 1').key)).toEqual(['tests/app.spec.ts#counter > increments']);
    // label(0) runs on the first page, before `navigates` leaves it for other.html.
    expect(dry.coverage.get(find('counter.ts', 'n >= 10', 'n > 10').key)?.sort()).toEqual(['tests/app.spec.ts#counter > increments', 'tests/app.spec.ts#navigates']);
    expect(dry.coverage.get(find('other.ts', 'toUpperCase', 'toLowerCase').key)).toEqual(['tests/app.spec.ts#navigates']);
    expect(dry.coverage.get(find('counter.ts', 'x * 3', 'x / 3').key)).toBeUndefined();
    // E2E tests reach the sources through the browser: every test file depends on every target.
    expect(dry.deps.get('tests/app.spec.ts')).toEqual(['src/counter.ts', 'src/main.ts', 'src/other.ts']);
  });

  test('a mutant a test observes is killed by that test', async () => {
    const result = await session.runMutant(find('counter.ts', 'n + 1', 'n - 1').key, ['tests/app.spec.ts#counter > increments'], { timeoutMs: 30_000 });
    expect(result).toMatchObject({ status: 'Killed', killedBy: ['tests/app.spec.ts#counter > increments'] });
    // The failing expect stops waiting for the text long before Playwright's default 5 s: it is
    // bounded by what the test took in the dry run.
    expect(result.durationMs).toBeLessThan(5000);
  });

  test('early exit stops at the first failing test; without it every failing test is reported (kill matrix)', async () => {
    const both = ['tests/app.spec.ts#counter > increments', 'tests/app.spec.ts#navigates'];
    const few = find('counter.ts', "'few'", "''").key;
    const early = await session.runMutant(few, both, { timeoutMs: 30_000 });
    expect(early.status).toBe('Killed');
    expect(early.killedBy).toHaveLength(1);
    const all = await session.runMutant(few, both, { timeoutMs: 30_000, earlyExit: false });
    expect(all.status).toBe('Killed');
    expect([...all.killedBy].sort()).toEqual(both);
  });

  test('a mutant no assertion notices survives', async () => {
    const result = await session.runMutant(find('counter.ts', 'n >= 10', 'n > 10').key, ['tests/app.spec.ts#counter > increments', 'tests/app.spec.ts#navigates'], { timeoutMs: 30_000 });
    expect(result).toMatchObject({ status: 'Survived', killedBy: [] });
  });

  test('a run past its budget is a timeout', async () => {
    const result = await session.runMutant(find('counter.ts', 'n + 1', 'n - 1').key, ['tests/app.spec.ts#counter > increments'], { timeoutMs: 1 });
    expect(result).toMatchObject({ status: 'Timeout', timeoutCause: 'time', killedBy: [] });
  });

});

describe('playwright session cleanup', { timeout: 120_000 }, () => {
  test('closing stops the dev server mutator started and removes the files it generated', async () => {
    mkdirSync(tmpRoot, { recursive: true });
    const root = join(tmpRoot, `app-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    const port = 5700 + (process.pid % 200);
    process.env.MUTATOR_TEST_PORT = String(port);
    try {
      const session = await createPlaywrightSession({ root, targets: [join(root, 'src/counter.ts')] });
      await session.dryRun();
      expect((await fetch(`http://localhost:${port}/`)).ok).toBe(true);
      await session.close();
      await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow();
      expect(readdirSync(root).filter((f) => f.includes('mutator'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
