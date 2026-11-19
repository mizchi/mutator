import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { assignPort } from '../../playwright/test/port.ts';
import { listMutants, runMutation } from '../src/run.ts';
import { selectTestsSince, selectionFiles } from '../src/select-tests.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('../../playwright/test/fixtures/app', import.meta.url));
// Inside packages/playwright, so the copy resolves @playwright/test, vite and the adapter.
const tmpRoot = fileURLToPath(new URL('../../playwright/.tmp', import.meta.url));

function commitFixture(root: string) {
  writeFileSync(join(root, '.gitignore'), '.mutator/\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'baseline');
}

describe('runMutation with Playwright (E2E through a Vite dev server)', { timeout: 300_000 }, () => {
  let root: string;
  beforeEach(async () => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `cli-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    await assignPort(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('mutator.config.ts explicitly enables browser mutation runs without runner flags', async () => {
    const configApi = new URL('../src/index.ts', import.meta.url).href;
    writeFileSync(join(root, 'mutator.config.ts'), `import { defineConfig } from ${JSON.stringify(configApi)};
export default defineConfig({ runner: 'playwright', playwrightConfig: 'playwright.config.ts', playwrightSourceCoverage: true, include: ['src/counter.ts'], concurrency: 1, timeBudget: 60 });
`);
    const mutant = (await listMutants({ root, runner: 'playwright', include: ['src/counter.ts'] }))
      .find((m) => m.original === 'n + 1' && m.replacement === 'n - 1')!;
    const child = spawn(process.execPath, [cli, '--root', root, '--only', mutant.key, '--reporter', 'agent'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((done) => child.on('close', done));
    expect(code, stderr).toBe(0);
    expect(stderr).toContain('runner: playwright');
    expect(JSON.parse(stdout).counts.Killed).toBe(1);
    const snapshot = JSON.parse(readFileSync(join(root, '.mutator/snapshot.json'), 'utf8'));
    expect(snapshot.sourceCoverage['src/counter.ts#inc']).toEqual(['tests/app.spec.ts#counter > increments']);
    expect(snapshot.sourceCoverageIncomplete).toEqual(['tests/app.spec.ts#navigates']);
  });

  test('classifies mutants, then a second run reuses everything', async () => {
    // The app's vite.config.ts would make auto pick vitest.
    const first = await runMutation({ root, runner: 'playwright', concurrency: 2, typecheck: false });
    const status = (original: string, replacement: string) => first.entries.find((e) => e.mutant.original === original && e.mutant.replacement === replacement)?.status;
    expect(status('n + 1', 'n - 1')).toBe('Killed');
    expect(status('toUpperCase', 'toLowerCase')).toBe('Killed');
    expect(status('n >= 10', 'n > 10')).toBe('Survived');
    expect(status('x * 3', 'x / 3')).toBe('NoCoverage');
    expect(first.executed).toBeGreaterThan(0);

    const second = await runMutation({ root, runner: 'playwright', concurrency: 2, typecheck: false });
    expect(second.executed).toBe(0);
    expect(second.dryRunFiles).toEqual([]);
    expect(second.entries.map((e) => e.status)).toEqual(first.entries.map((e) => e.status));

    // A helper the spec imports changed: its coverage is collected again.
    writeFileSync(join(root, 'tests/pages.ts'), `${readFileSync(join(root, 'tests/pages.ts'), 'utf8')}// edited\n`);
    const third = await runMutation({ root, runner: 'playwright', concurrency: 2, typecheck: false });
    expect(third.dryRunFiles).toEqual(['tests/app.spec.ts']);
  });

  test('a source-only scope edit re-collects only the E2E that executed it', async () => {
    rmSync(join(root, 'tests/app.spec.ts'));
    writeFileSync(join(root, 'tests/inc.spec.ts'), `import { expect, test } from '@mizchi/mutator-playwright';
test('increments', async ({ page }) => { await page.goto('/'); await page.click('#count'); await expect(page.locator('#count')).toHaveText('1'); });\n`);
    writeFileSync(join(root, 'tests/other.spec.ts'), `import { expect, test } from '@mizchi/mutator-playwright';
test('other', async ({ page }) => { await page.goto('/other.html'); await expect(page.locator('#out')).toHaveText('HI'); });\n`);
    const identity = join(root, 'src/identity.ts');
    writeFileSync(identity, 'export const identity = (value: number) => value;\n');
    const main = join(root, 'src/main.ts');
    writeFileSync(main, "import { identity } from './identity.ts';\n" + readFileSync(main, 'utf8').replace('const n = inc(Number(count.textContent));', 'const n = identity(inc(Number(count.textContent)));'));
    commitFixture(root);
    const options = { root, runner: 'playwright' as const, playwrightSourceCoverage: true, include: ['src/*.ts'], excludedMutators: ['ArrowFunction'], typecheck: false as const, concurrency: 1, timeBudget: 60 };
    const key = (await listMutants(options)).find((m) => m.original === 'n + 1' && m.replacement === 'n - 1')!.key;
    const first = await runMutation({ ...options, only: new Set([key]) });
    expect(first.executed).toBe(1);
    expect(first.dryRunFiles).toEqual(['tests/inc.spec.ts', 'tests/other.spec.ts']);
    const snapshot = JSON.parse(readFileSync(join(root, '.mutator/snapshot.json'), 'utf8'));
    expect(snapshot.sourceCoverage['src/identity.ts#identity']).toEqual(['tests/inc.spec.ts#increments']);
    expect(snapshot.sourceCoverageIncomplete).toEqual([]);
    writeFileSync(identity, 'export const identity = (value: number) => Number(value);\n');
    expect((await listMutants(options)).filter((mutant) => mutant.file === identity)).toEqual([]);
    expect(selectionFiles(await selectTestsSince({ ...options, since: 'HEAD' }))).toEqual(['tests/inc.spec.ts']);
    const next = await runMutation({ ...options, only: new Set([key]) });
    expect(next.dryRunFiles).toEqual(['tests/inc.spec.ts']);
    expect(next.executed).toBe(1);
  });

  test('removing a re-export selects the browser tests that load a module with no scopes', async () => {
    const api = join(root, 'src/api.ts');
    writeFileSync(api, "export { inc, label } from './counter.ts';\n");
    const main = join(root, 'src/main.ts');
    writeFileSync(main, readFileSync(main, 'utf8').replace("from './counter.ts'", "from './api.ts'"));
    commitFixture(root);
    const options = { root, runner: 'playwright' as const, playwrightSourceCoverage: true, typecheck: false as const, include: ['src/*.ts'], concurrency: 1 };
    const key = (await listMutants(options)).find((m) => m.original === 'n + 1' && m.replacement === 'n - 1')!.key;
    await runMutation({ ...options, only: new Set([key]) });

    writeFileSync(api, "export { label } from './counter.ts';\n");
    const selection = await selectTestsSince({ ...options, since: 'HEAD' });
    expect(selectionFiles(selection)).toEqual(['tests/app.spec.ts']);
    expect(selection.changedTests).toContainEqual({ file: 'tests/app.spec.ts', reason: 'imports src/api.ts' });
  });

  test('a dev server port already in use is an error message with exit 1, not a crash', async () => {
    const port = Number(readFileSync(join(root, 'port'), 'utf8'));
    const other = createServer((_, res) => res.end('not mutator'));
    await new Promise<void>((done) => other.listen(port, 'localhost', done));
    try {
      // Not spawnSync: the server above must keep answering while mutator runs.
      const child = spawn(process.execPath, [cli, '--root', root, '--runner', 'playwright', '--no-typecheck'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const status = await new Promise<number | null>((done) => child.on('close', done));
      expect(stderr).toContain(`mutator: http://localhost:${port} already answers; stop that server`);
      expect(stderr).not.toMatch(/\n\s+at /);
      expect(status).toBe(1);
    } finally {
      other.close();
    }
  });
});
