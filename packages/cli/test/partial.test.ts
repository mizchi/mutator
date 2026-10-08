import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type Report, runMutation } from '../src/run.ts';

const fixture = fileURLToPath(new URL('./fixtures/multi', import.meta.url));
const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));

const statuses = (report: Report) =>
  Object.fromEntries(report.entries.map((e) => [`${e.mutant.file.split('/').pop()}:${e.mutant.original} -> ${e.mutant.replacement}`, e.status]));

describe('partial dry run', { timeout: 60_000 }, () => {
  let root: string;
  beforeEach(() => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `partial-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const edit = (rel: string, from: string, to: string) => {
    const file = join(root, rel);
    writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));
  };

  test('first run collects coverage from every test file', async () => {
    const report = await runMutation({ root, concurrency: 1 });
    expect(report.dryRunFiles).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });

  test('unchanged project needs no dry run at all', async () => {
    await runMutation({ root, concurrency: 1 });
    const second = await runMutation({ root, concurrency: 1 });
    expect(second.dryRunFiles).toEqual([]);
    expect(second.executed).toBe(0);
  });

  test('a source edit only re-collects test files that covered the edited function', async () => {
    await runMutation({ root, concurrency: 1 });
    edit('src/a.ts', 'return n * 2;', 'return n + n;');
    const partial = await runMutation({ root, concurrency: 1 });
    expect(partial.dryRunFiles).toEqual(['test/a.test.ts']);

    // Same verdicts as a cold run on the edited project.
    const cold = await runMutation({ root, concurrency: 1, snapshotPath: join(root, '.mutator/cold.json') });
    expect(cold.dryRunFiles).toEqual(['test/a.test.ts', 'test/b.test.ts']);
    expect(statuses(partial)).toEqual(statuses(cold));
  });

  test('a test-only edit re-collects only that test file', async () => {
    await runMutation({ root, concurrency: 1 });
    edit('test/a.test.ts', 'expect(isPositive(-1)).toBe(false);', 'expect(isPositive(-1)).toBe(false);\n  expect(isPositive(0)).toBe(false);');
    const report = await runMutation({ root, concurrency: 1 });
    expect(report.dryRunFiles).toEqual(['test/a.test.ts']);
    const boundary = report.entries.find((e) => e.mutant.original === 'n > 0' && e.mutant.replacement === 'n >= 0')!;
    expect(boundary.status).toBe('Killed');
  });

  test('--full-dry-run forces a complete coverage run', async () => {
    await runMutation({ root, concurrency: 1 });
    const report = await runMutation({ root, concurrency: 1, fullDryRun: true });
    expect(report.dryRunFiles).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });
});

describe('portable snapshot', { timeout: 60_000 }, () => {
  test('a snapshot restored in another checkout is reused', async () => {
    mkdirSync(tmpRoot, { recursive: true });
    const a = join(tmpRoot, `portable-a-${process.pid}`);
    const b = join(tmpRoot, `portable-b-${process.pid}`);
    try {
      cpSync(fixture, a, { recursive: true });
      await runMutation({ root: a, concurrency: 1 });
      cpSync(a, b, { recursive: true });
      const report = await runMutation({ root: b, concurrency: 1 });
      expect(report.executed).toBe(0);
      expect(report.dryRunFiles).toEqual([]);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('--since keeps invalidation for out-of-diff mutants', { timeout: 60_000 }, () => {
  test('mutants planned for re-run but outside the diff are not cached as fresh', async () => {
    mkdirSync(tmpRoot, { recursive: true });
    const root = join(tmpRoot, `since-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env });
    try {
      git('init', '-q', '-b', 'main');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      await runMutation({ root, concurrency: 1 });

      // `combo` covers both functions: editing `double` invalidates isPositive's results too.
      const file = join(root, 'src/a.ts');
      writeFileSync(file, readFileSync(file, 'utf8').replace('return n * 2;', 'return n + n;'));
      const since = await runMutation({ root, concurrency: 1, since: 'HEAD' });
      const pending = since.entries.filter((e) => e.source === 'skipped').map((e) => e.mutant.scope.id);
      expect(new Set(pending)).toEqual(new Set(['isPositive']));

      const full = await runMutation({ root, concurrency: 1 });
      const rerun = full.entries.filter((e) => e.source === 'run').map((e) => e.mutant.key).sort();
      expect(rerun).toEqual(since.entries.filter((e) => e.source === 'skipped').map((e) => e.mutant.key).sort());
      expect(full.entries.some((e) => e.status === 'NoCoverage' && e.mutant.scope.id === 'isPositive')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
