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
    edit('test/a.test.ts', 'expect(isPositive(NEGATIVE)).toBe(false);', 'expect(isPositive(NEGATIVE)).toBe(false);\n  expect(isPositive(0)).toBe(false);');
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
      // Weak mutation would decide some of isPositive's mutants without running them;
      // this test is about the ones that must be re-run.
      await runMutation({ root, concurrency: 1, weakMutation: false });

      // `combo` covers both functions: editing `double` invalidates isPositive's results too.
      const file = join(root, 'src/a.ts');
      writeFileSync(file, readFileSync(file, 'utf8').replace('return n * 2;', 'return n + n;'));
      const since = await runMutation({ root, concurrency: 1, since: 'HEAD', weakMutation: false });
      const pending = since.entries.filter((e) => e.source === 'skipped').map((e) => e.mutant.scope.id);
      expect(new Set(pending)).toEqual(new Set(['isPositive']));

      const full = await runMutation({ root, concurrency: 1, weakMutation: false });
      const rerun = full.entries.filter((e) => e.source === 'run').map((e) => e.mutant.key).sort();
      expect(rerun).toEqual(since.entries.filter((e) => e.source === 'skipped').map((e) => e.mutant.key).sort());
      expect(full.entries.some((e) => e.status === 'NoCoverage' && e.mutant.scope.id === 'isPositive')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('--since leaves out-of-diff mutants undecided', { timeout: 60_000 }, () => {
  test('even those weak mutation would decide without running', async () => {
    mkdirSync(tmpRoot, { recursive: true });
    const root = join(tmpRoot, `since-weak-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env });
    try {
      git('init', '-q', '-b', 'main');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      const first = await runMutation({ root, concurrency: 1 });
      expect(first.entries.some((e) => e.source === 'static' && e.status === 'Survived' && e.mutant.scope.id === 'isPositive')).toBe(true);

      const file = join(root, 'src/a.ts');
      writeFileSync(file, readFileSync(file, 'utf8').replace('return n * 2;', 'return n + n;'));
      const since = await runMutation({ root, concurrency: 1, since: 'HEAD' });
      const decided = since.entries.filter((e) => e.mutant.scope.id === 'isPositive' && e.source !== 'reuse' && e.source !== 'skipped');
      expect(decided).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('--since runs the diff only', { timeout: 60_000 }, () => {
  const setup = async (name: string) => {
    mkdirSync(tmpRoot, { recursive: true });
    const root = join(tmpRoot, `${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const first = await runMutation({ root, concurrency: 1, weakMutation: false });
    return { root, first };
  };
  const edit = (root: string, rel: string, from: string, to: string) => {
    const file = join(root, rel);
    writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));
  };

  test('a test added to a changed test file does not pull in the code it covers', async () => {
    const { root } = await setup('since-added');
    try {
      edit(root, 'test/a.test.ts', "test('combo'", "test('more', () => {\n  expect(double(3)).toBe(6);\n});\n\ntest('combo'");
      const since = await runMutation({ root, concurrency: 1, since: 'HEAD', weakMutation: false });
      expect(since.executed).toBe(0);
      expect(since.entries.filter((e) => e.focus)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a changed test file the runner does not collect is reported', async () => {
    const { root, first } = await setup('since-uncollected');
    try {
      expect(first.uncollectedTests).toBeUndefined();
      writeFileSync(join(root, 'test/extra.spec.ts'), "import { test } from 'vitest';\ntest('x', () => {});\n");
      // Excluded by the runner's config on purpose: not a mistake to warn about.
      edit(root, 'vitest.config.ts', "include: ['test/**/*.test.ts'] }", "include: ['test/**/*.test.ts'], exclude: ['test/fixtures/**'] }");
      mkdirSync(join(root, 'test/fixtures'), { recursive: true });
      writeFileSync(join(root, 'test/fixtures/sample.test.ts'), "import { test } from 'vitest';\ntest('x', () => {});\n");
      edit(root, 'test/helper.ts', 'export', '// edited\nexport');
      edit(root, 'test/a.test.ts', "test('combo'", "test.skip('later', () => {});\n\ntest('combo'");
      const since = await runMutation({ root, concurrency: 1, since: 'HEAD', weakMutation: false });
      expect(since.uncollectedTests).toEqual(['test/extra.spec.ts']);
      expect(since.skippedTests).toEqual([{ file: 'test/a.test.ts', line: expect.any(Number), text: "test.skip('later', () => {});" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('mutants outside the diff are rechecked when every test that killed them is gone', async () => {
    const { root, first } = await setup('since-removed');
    try {
      const removed = 'test/a.test.ts#isPositive';
      const orphaned = first.entries.filter((e) => e.status === 'Killed' && e.killedBy.length > 0 && e.killedBy.every((t) => t === removed)).map((e) => e.mutant.key);
      expect(orphaned.length).toBeGreaterThan(0);
      edit(root, 'test/a.test.ts', "test('isPositive', () => {\n  expect(isPositive(1)).toBe(true);\n  expect(isPositive(NEGATIVE)).toBe(false);\n});\n", '');
      const since = await runMutation({ root, concurrency: 1, since: 'HEAD', weakMutation: false });
      const rechecked = since.entries.filter((e) => e.focus === 'recheck').map((e) => e.mutant.key);
      expect(rechecked.sort()).toEqual(orphaned.sort());
      expect(since.entries.filter((e) => e.source === 'run').every((e) => e.focus === 'recheck')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('test dependencies', { timeout: 60_000 }, () => {
  test('editing a non-mutated helper a test imports re-runs the affected mutants', async () => {
    mkdirSync(tmpRoot, { recursive: true });
    const root = join(tmpRoot, `deps-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    try {
      const first = await runMutation({ root, concurrency: 1 });
      const boundary = (r: Report) => r.entries.find((e) => e.mutant.original === 'n > 0' && e.mutant.replacement === 'n >= 0')!;
      expect(boundary(first).status).toBe('Survived');

      writeFileSync(join(root, 'test/helper.ts'), 'export const NEGATIVE = 0;\n');
      const second = await runMutation({ root, concurrency: 1 });
      expect(second.dryRunFiles).toEqual(['test/a.test.ts']);
      expect(boundary(second).source).toBe('run');
      expect(boundary(second).status).toBe('Killed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('weak mutation verdicts', { timeout: 60_000 }, () => {
  test('a survivor decided without running is marked not infected, and stays so when reused', async () => {
    mkdirSync(tmpRoot, { recursive: true });
    const root = join(tmpRoot, `reason-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    try {
      const first = await runMutation({ root, concurrency: 1 });
      const decided = first.entries.filter((e) => e.source === 'static' && e.status === 'Survived');
      expect(decided.length).toBeGreaterThan(0);
      expect(decided.every((e) => e.reason === 'notInfected')).toBe(true);
      expect(first.entries.filter((e) => e.source === 'run').every((e) => e.reason === undefined)).toBe(true);

      const second = await runMutation({ root, concurrency: 1 });
      const keys = new Set(decided.map((e) => e.mutant.key));
      const reused = second.entries.filter((e) => keys.has(e.mutant.key));
      expect(reused.every((e) => e.source === 'reuse' && e.reason === 'notInfected')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
