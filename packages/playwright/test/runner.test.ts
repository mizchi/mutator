import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    runner = createProcessRunner({ cli, config: join(root, 'playwright.config.ts'), cwd: root, runFile: join(root, 'run.json') });
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
        ['fails', 'unexpected', join(root, 'tests/plain.spec.ts'), 7],
        ['passes', 'expected', join(root, 'tests/plain.spec.ts'), 3],
      ]);
    }
  });

  test('runs only the tests at the given locations', async () => {
    const outcome = await run([`${join(root, 'tests/plain.spec.ts')}:3`]);
    expect(outcome.results!.tests.map((t) => t.titles)).toEqual([['passes']]);
  });
});
