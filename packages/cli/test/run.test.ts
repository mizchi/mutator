import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runMutation } from '../src/run.ts';

const fixture = fileURLToPath(new URL('../../vitest/test/fixtures/basic', import.meta.url));
// Inside the workspace so the fixture resolves `vitest` from the root node_modules.
const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

describe('runMutation', () => {
  let root: string;
  beforeEach(() => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `run-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const byStatus = (report: Awaited<ReturnType<typeof runMutation>>) => {
    const out: Record<string, string[]> = {};
    for (const r of report.entries) (out[r.status] ??= []).push(`${r.mutant.original} -> ${r.mutant.replacement}`);
    return out;
  };

  test('full run classifies every mutant', async () => {
    const report = await runMutation({ root });
    const statuses = byStatus(report);
    expect(statuses.Killed).toContain('a + b -> a - b');
    expect(statuses.Killed).toContain('10 * 2 -> 10 / 2');
    expect(statuses.Survived).toContain('age >= 18 -> age > 18');
    expect(statuses.NoCoverage).toContain('x * 3 -> x / 3');
    expect(report.executed).toBe(report.entries.filter((e) => e.source === 'run').length);
    expect(report.score).toBeGreaterThan(0);
  });

  test('parallel execution gives the same verdicts as sequential', async () => {
    const sequential = await runMutation({ root, concurrency: 1, snapshotPath: join(root, '.mutator/seq.json') });
    const parallel = await runMutation({ root, concurrency: 3, snapshotPath: join(root, '.mutator/par.json') });
    expect(parallel.executed).toBe(sequential.executed);
    expect(byStatus(parallel)).toEqual(byStatus(sequential));
  });

  test('second run reuses everything from the snapshot', async () => {
    const first = await runMutation({ root });
    const second = await runMutation({ root });
    expect(second.executed).toBe(0);
    expect(byStatus(second)).toEqual(byStatus(first));
  });

  test('editing one function only re-runs mutants of that function', async () => {
    await runMutation({ root });
    const file = join(root, 'src/math.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('return age >= 18;', 'return age >= 21;'));
    const report = await runMutation({ root });
    const ran = report.entries.filter((e) => e.source === 'run').map((e) => e.mutant.scope.id);
    expect(ran.length).toBeGreaterThan(0);
    expect(new Set(ran)).toEqual(new Set(['isAdult']));
  });

  test('--since restricts execution to mutants inside the diff', async () => {
    const file = join(root, 'src/math.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('return a + b;', 'return b + a;'));
    const report = await runMutation({ root, since: 'HEAD' });
    const ran = report.entries.filter((e) => e.source === 'run').map((e) => e.mutant.original);
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.every((o) => o.includes('b + a') || o === 'b + a')).toBe(true);
    expect(report.entries.some((e) => e.source === 'skipped')).toBe(true);
  });

  test('a test-only change re-runs the mutants it covers', async () => {
    await runMutation({ root });
    const testFile = join(root, 'test/math.test.ts');
    writeFileSync(testFile, readFileSync(testFile, 'utf8').replace('expect(isAdult(3)).toBe(false);', 'expect(isAdult(3)).toBe(false);\n    expect(isAdult(18)).toBe(true);'));
    const report = await runMutation({ root });
    const boundary = report.entries.find((e) => e.mutant.original === 'age >= 18' && e.mutant.replacement === 'age > 18')!;
    expect(boundary.source).toBe('run');
    expect(boundary.status).toBe('Killed');
  });
});
