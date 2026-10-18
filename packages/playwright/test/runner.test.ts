import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type TestRunner, createProcessRunner } from '../src/runner.ts';

const fixture = fileURLToPath(new URL('./fixtures/plain', import.meta.url));
const tmpRoot = fileURLToPath(new URL('../.tmp', import.meta.url));

describe('process runner', { timeout: 60_000 }, () => {
  let root: string;
  let runner: TestRunner;
  beforeAll(async () => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `plain-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    const cli = createRequire(join(root, 'package.json')).resolve('@playwright/test/cli');
    runner = createProcessRunner({ cli, config: join(root, 'playwright.config.ts'), cwd: root, runFile: join(root, 'run.json'), outputDir: join(root, 'test-results') });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (locations: string[]) => {
    const results = join(root, 'results.json');
    writeFileSync(join(root, 'run.json'), JSON.stringify({ active: null, hitLimit: 1, results }));
    return runner.run({ locations, projects: [], workers: 1, results }, 30_000);
  };

  test('reports every test with its outcome, run after run', async () => {
    for (let i = 0; i < 2; i++) {
      const outcome = await run([]);
      expect(outcome.timedOut).toBe(false);
      const tests = outcome.results!.tests.map((t) => [t.titles.join(' > '), t.outcome, t.file, t.line]);
      expect(tests.sort()).toEqual([
        ['fails', 'unexpected', join(root, 'tests/plain.spec.ts'), 16],
        ['passes', 'expected', join(root, 'tests/plain.spec.ts'), 9],
        ['waits', 'expected', join(root, 'tests/plain.spec.ts'), 22],
      ]);
    }
  });

  test('a process a test leaves behind does not outlive the run', async () => {
    const marker = join(root, 'leave-process');
    writeFileSync(marker, '');
    try {
      await run([`${join(root, 'tests/plain.spec.ts')}:9`]);
      const pid = Number(readFileSync(marker, 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(marker, { force: true });
    }
  });

  test('a run whose config breaks has no results, and says why on stderr', async () => {
    const results = join(root, 'results.json');
    writeFileSync(join(root, 'run.json'), JSON.stringify({ active: 'break-config', hitLimit: 1, results }));
    const outcome = await runner.run({ locations: [], projects: [], workers: 1, results }, 30_000);
    expect(outcome.results).toBeUndefined();
    expect(outcome.stderr).toContain('the config broke');
  });

  test('runs only the tests at the given locations', async () => {
    const outcome = await run([`${join(root, 'tests/plain.spec.ts')}:9`]);
    expect(outcome.results!.tests.map((t) => t.titles)).toEqual([['passes']]);
  });
});

describe('process runner with several projects', { timeout: 60_000 }, () => {
  test('runs only the tests of the given projects', async () => {
    mkdirSync(tmpRoot, { recursive: true });
    const root = join(tmpRoot, `plain-projects-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    try {
      const cli = createRequire(join(root, 'package.json')).resolve('@playwright/test/cli');
      const runner = createProcessRunner({ cli, config: join(root, 'playwright.projects.config.ts'), cwd: root, runFile: join(root, 'run.json'), outputDir: join(root, 'test-results') });
      const results = join(root, 'results.json');
      writeFileSync(join(root, 'run.json'), JSON.stringify({ active: null, hitLimit: 1, results }));
      const outcome = await runner.run({ locations: [], projects: ['b'], workers: 1, results }, 30_000);
      expect(outcome.results!.tests.map((t) => `${t.project} ${t.titles.join(' > ')}`).sort()).toEqual(['b fails', 'b passes', 'b waits']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
