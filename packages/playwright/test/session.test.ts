import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mutant, Session } from '@mizchi/mutator-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPlaywrightSession, expectTimeoutFor } from '../src/session.ts';
import { assignPort } from './port.ts';

const fixture = fileURLToPath(new URL('./fixtures/app', import.meta.url));
// Inside this package, so the copy resolves @playwright/test, vite and this package itself.
const tmpRoot = fileURLToPath(new URL('../.tmp', import.meta.url));
const packageDir = fileURLToPath(new URL('..', import.meta.url));

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
    await assignPort(root);
    session = await createPlaywrightSession({ root, targets: ['counter.ts', 'main.ts', 'other.ts'].map((f) => join(root, 'src', f)) });
    dry = await session.dryRun();
  });
  afterAll(async () => {
    await session?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('lists the test files, and the config as what every test depends on', async () => {
    expect(await session.testFiles()).toEqual([join(root, 'tests/app.spec.ts')]);
    expect(session.configFiles()).toEqual([join(root, 'playwright.config.ts')]);
  });

  test('a dry run of no test files runs nothing; one of some files runs only theirs', async () => {
    expect((await session.dryRun([])).tests).toEqual([]);
    const some = await session.dryRun([join(root, 'tests/app.spec.ts')]);
    expect(some.tests.map((t) => t.id).sort()).toEqual(['tests/app.spec.ts#counter > increments', 'tests/app.spec.ts#navigates']);
  });

  test("another session runs mutants from this one's test index, as the CLI's parallel sessions do", async () => {
    const other = await createPlaywrightSession({ root, targets: ['counter.ts', 'main.ts', 'other.ts'].map((f) => join(root, 'src', f)) });
    try {
      other.useTestIndex(dry.index);
      const key = find('counter.ts', 'n + 1', 'n - 1').key;
      expect(await other.runMutant(key, ['tests/app.spec.ts#counter > increments'], { timeoutMs: 30_000 })).toMatchObject({ status: 'Killed' });
      // The index replaces what the session knew: a test it does not name cannot be run.
      other.useTestIndex(new Map());
      expect(await other.runMutant(key, ['tests/app.spec.ts#counter > increments'], { timeoutMs: 30_000 })).toEqual({ status: 'Survived', killedBy: [], durationMs: 0 });
    } finally {
      await other.close();
    }
  });

  test('by default, mutants the dev server probes are listed for weak mutation, and the probes report infection', () => {
    const weak = session.mutants().filter((m) => m.weak);
    expect(weak.length).toBeGreaterThan(0);
    expect(dry.infected?.size).toBeGreaterThan(0);
    expect([...(dry.infected?.keys() ?? [])].every((k) => weak.some((m) => m.key === k))).toBe(true);
  });

  test('the dry run records which test reached which mutant, across navigations', () => {
    expect(dry.tests.map((t) => t.id).sort()).toEqual(['tests/app.spec.ts#counter > increments', 'tests/app.spec.ts#navigates']);
    expect(dry.failed).toEqual([]);
    expect(dry.coverage.get(find('counter.ts', 'n + 1', 'n - 1').key)).toEqual(['tests/app.spec.ts#counter > increments']);
    // label(0) runs on the first page, before `navigates` leaves it for other.html.
    expect(dry.coverage.get(find('counter.ts', 'n >= 10', 'n > 10').key)?.sort()).toEqual(['tests/app.spec.ts#counter > increments', 'tests/app.spec.ts#navigates']);
    expect(dry.coverage.get(find('other.ts', 'toUpperCase', 'toLowerCase').key)).toEqual(['tests/app.spec.ts#navigates']);
    expect(dry.coverage.get(find('counter.ts', 'x * 3', 'x / 3').key)).toBeUndefined();
    // E2E tests reach the sources through the browser: every test file depends on every target,
    // and on the local files it imports (a helper edit re-collects its coverage).
    expect(dry.deps.get('tests/app.spec.ts')).toEqual(['src/counter.ts', 'src/main.ts', 'src/other.ts', 'tests/pages.ts']);
    // Each test's fingerprint covers its file's content and its id: reuse tells them apart.
    expect(new Set(dry.tests.map((t) => t.fingerprint)).size).toBe(dry.tests.length);
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
    // The stuck run was killed with its process group; the next run is not affected.
    const next = await session.runMutant(find('counter.ts', 'n + 1', 'n - 1').key, ['tests/app.spec.ts#counter > increments'], { timeoutMs: 30_000 });
    expect(next).toMatchObject({ status: 'Killed', killedBy: ['tests/app.spec.ts#counter > increments'] });
  });
});

describe('playwright session instrument options', { timeout: 120_000 }, () => {
  const core = fileURLToPath(new URL('../../core/src/index.ts', import.meta.url));
  const PLUGIN = `import { defineIgnorer, defineMutator, definePlugin } from ${JSON.stringify(core)};
export default definePlugin({
  name: 'fallbacks',
  mutators: [defineMutator({ name: 'DropFallback', visit(node, ctx) { if (node.type === 'LogicalExpression' && node.operator === '??') return [{ replacement: ctx.text(node.left) }]; } })],
  ignorers: [defineIgnorer({ name: 'no-unused', shouldIgnore(node) { if (node.type === 'FunctionDeclaration' && node.id?.name === 'unused') return 'never called'; } })],
});
`;

  test('reach the dev server: what the pages report are the mutants the session lists', async () => {
    mkdirSync(tmpRoot, { recursive: true });
    const root = join(tmpRoot, `options-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    await assignPort(root);
    writeFileSync(join(root, 'fallbacks.ts'), PLUGIN);
    const plugin = (await import(join(root, 'fallbacks.ts'))).default;
    const session = await createPlaywrightSession({
      root,
      targets: ['counter.ts', 'main.ts'].map((f) => join(root, 'src', f)),
      excludedMutators: ['StringLiteral'],
      arid: false,
      weak: false,
      mutators: plugin.mutators,
      ignorers: plugin.ignorers,
      pluginModules: [join(root, 'fallbacks.ts')],
    });
    try {
      const mutants = session.mutants();
      const keys = new Set(mutants.map((m) => m.key));
      expect(mutants.some((m) => m.mutator === 'StringLiteral')).toBe(false);
      // arid: false keeps the logging call's mutants; the plugin's mutator adds one.
      const logged = mutants.find((m) => m.original === "Number(count.textContent ?? '0') + 1" && m.replacement === "Number(count.textContent ?? '0') - 1")!;
      expect(logged.ignored).toBeUndefined();
      const fallback = mutants.find((m) => m.mutator === 'DropFallback')!;
      expect(mutants.filter((m) => m.scope.id === 'unused').every((m) => m.ignored === 'no-unused: never called')).toBe(true);
      // weak: false lists no mutant for weak mutation, as the dev server adds no probes for it:
      // the CLI would otherwise decide them as not infected without running them.
      expect(mutants.some((m) => m.weak)).toBe(false);
      const dry = await session.dryRun();
      expect([...dry.coverage.keys()].filter((k) => !keys.has(k))).toEqual([]);
      // The dev server instrumented the same way: both are reached in the page.
      expect(dry.coverage.has(logged.key)).toBe(true);
      expect(dry.coverage.has(fallback.key)).toBe(true);
      // weak: false reaches the dev server too: nothing is recorded as infected.
      expect(dry.infected ?? new Map()).toEqual(new Map());
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('playwright session with several projects', { timeout: 120_000 }, () => {
  let root: string;
  let session: Session;
  beforeAll(async () => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `projects-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    await assignPort(root);
    session = await createPlaywrightSession({ root, targets: [join(root, 'src/counter.ts')], configFile: join(root, 'playwright.projects.config.ts') });
  });
  afterAll(async () => {
    await session?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('test ids name the project, and a mutant is killed by the test of the project selected', async () => {
    const dry = await session.dryRun();
    expect(dry.tests.map((t) => t.id).sort()).toEqual([
      'tests/app.spec.ts#[one] counter > increments',
      'tests/app.spec.ts#[one] navigates',
      'tests/app.spec.ts#[two] counter > increments',
      'tests/app.spec.ts#[two] navigates',
    ]);
    const inc = session.mutants().find((m) => m.original === 'n + 1' && m.replacement === 'n - 1')!;
    expect(dry.coverage.get(inc.key)?.sort()).toEqual(['tests/app.spec.ts#[one] counter > increments', 'tests/app.spec.ts#[two] counter > increments']);
    const result = await session.runMutant(inc.key, ['tests/app.spec.ts#[two] counter > increments'], { timeoutMs: 30_000 });
    expect(result).toMatchObject({ status: 'Killed', killedBy: ['tests/app.spec.ts#[two] counter > increments'] });
  });
});

describe('playwright session failures', { timeout: 120_000 }, () => {
  const plain = fileURLToPath(new URL('./fixtures/plain', import.meta.url));
  let root: string;
  beforeAll(() => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `plain-session-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(plain, root, { recursive: true });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('a test failing without any mutant is a dry-run failure; a run that breaks under a mutant is a runtime error', async () => {
    const session = await createPlaywrightSession({ root, targets: [] });
    try {
      const dry = await session.dryRun();
      expect(dry.failed).toEqual(['tests/plain.spec.ts#fails']);
      const result = await session.runMutant('break-config', ['tests/plain.spec.ts#passes'], { timeoutMs: 30_000 });
      expect(result).toMatchObject({ status: 'RuntimeError', killedBy: [] });
      // A test that waits 1.5 s for its expect still passes: the bound follows what it took in the dry run.
      expect(await session.runMutant('no-such-mutant', ['tests/plain.spec.ts#waits'], { timeoutMs: 30_000 })).toMatchObject({ status: 'Survived' });
    } finally {
      await session.close();
    }
  });

  test('a dry run without results fails with what Playwright printed', async () => {
    const session = await createPlaywrightSession({ root, targets: [] });
    writeFileSync(join(root, 'break-dry-run'), '');
    try {
      await expect(session.dryRun()).rejects.toThrow(/playwright produced no results[\s\S]*the config broke/);
    } finally {
      rmSync(join(root, 'break-dry-run'));
      await session.close();
    }
  });

  test('a project without a Playwright config, or with one Playwright cannot load, is an error', async () => {
    await expect(createPlaywrightSession({ root: join(root, 'tests'), targets: [] })).rejects.toThrow(/no Playwright config \(playwright\.config\.ts, /);
    writeFileSync(join(root, 'broken.config.ts'), "throw new Error('cannot load');\n");
    try {
      await expect(createPlaywrightSession({ root, targets: [], configFile: join(root, 'broken.config.ts') })).rejects.toThrow(/playwright test --list failed[\s\S]*cannot load/);
    } finally {
      rmSync(join(root, 'broken.config.ts'));
    }
  });

  test('a test file that fails to load under a mutant is a runtime error', async () => {
    const session = await createPlaywrightSession({ root, targets: [] });
    try {
      await session.dryRun();
      const result = await session.runMutant('break-file', ['tests/plain.spec.ts#passes'], { timeoutMs: 30_000 });
      expect(result).toMatchObject({ status: 'RuntimeError', killedBy: [] });
    } finally {
      await session.close();
    }
  });

  test('a dev server that fails to start fails the run, and the session still closes', async () => {
    writeFileSync(join(root, 'served.config.ts'), "export default { testDir: 'tests', webServer: { command: 'echo no >&2; exit 1', url: 'http://localhost:1/' } };\n");
    const session = await createPlaywrightSession({ root, targets: [], configFile: join(root, 'served.config.ts') });
    try {
      await expect(session.dryRun()).rejects.toThrow(/the dev server \(echo no >&2; exit 1\) exited before http:\/\/localhost:1\/ answered\nno/);
    } finally {
      await session.close();
      rmSync(join(root, 'served.config.ts'));
    }
  });

  test('a test file that fails to load fails the dry run', async () => {
    writeFileSync(join(root, 'tests/broken.spec.ts'), "throw new Error('the test file broke');\n");
    const session = await createPlaywrightSession({ root, targets: [] });
    try {
      const dry = await session.dryRun();
      expect(dry.failed.some((f) => f.includes('the test file broke'))).toBe(true);
    } finally {
      await session.close();
      rmSync(join(root, 'tests/broken.spec.ts'));
    }
  });
});

describe('playwright session cleanup', { timeout: 120_000 }, () => {
  test('closing stops the dev server mutator started and removes the files it generated', async () => {
    mkdirSync(tmpRoot, { recursive: true });
    const root = join(tmpRoot, `app-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    const port = await assignPort(root);
    try {
      const session = await createPlaywrightSession({ root, targets: [join(root, 'src/counter.ts')] });
      await session.dryRun();
      expect((await fetch(`http://localhost:${port}/`)).ok).toBe(true);
      await session.close();
      await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow();
      expect(readdirSync(root).filter((f) => f.includes('mutator'))).toEqual([]);
      // Playwright's output (test-results/, next to the nearest package.json) goes to mutator's own directory.
      expect(existsSync(join(packageDir, 'test-results'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('expect timeouts in mutant runs are bounded by three times the slowest selected test, at least 1 s', () => {
  expect(expectTimeoutFor([])).toBe(1000);
  expect(expectTimeoutFor([200])).toBe(1000);
  expect(expectTimeoutFor([100, 1000, 600])).toBe(3000);
});
