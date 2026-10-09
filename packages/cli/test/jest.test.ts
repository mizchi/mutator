import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runMutation } from '../src/run.ts';

const fixture = fileURLToPath(new URL('../../jest/test/fixtures/esm', import.meta.url));
// Inside packages/cli so the fixture resolves `jest` from this package's node_modules.
const tmpRoot = fileURLToPath(new URL('../.tmp', import.meta.url));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

describe('runMutation with Jest (ESM)', { timeout: 120_000 }, () => {
  let root: string;
  beforeEach(() => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `jest-${process.pid}-${Math.random().toString(36).slice(2)}`);
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

  test('classifies mutants, then a second run reuses everything', async () => {
    const first = await runMutation({ root, runner: 'jest', concurrency: 2 });
    const statuses = byStatus(first);
    expect(statuses.Killed).toContain('a + b -> a - b');
    expect(statuses.Killed).toContain('10 * 2 -> 10 / 2');
    expect(statuses.Survived).toContain('age >= 18 -> age > 18');
    expect(statuses.NoCoverage).toContain('x * 3 -> x / 3');
    expect(statuses.Timeout).toContain('i-- -> i++');
    expect(first.executed).toBeGreaterThan(0);

    const second = await runMutation({ root, runner: 'jest' });
    expect(second.executed).toBe(0);
    expect(second.dryRunFiles).toEqual([]);
    expect(byStatus(second)).toEqual(statuses);
  });

  test('plugin modules reach the Jest transformer', async () => {
    writeFileSync(
      join(root, 'plugin.js'),
      `export default { name: 'p', mutators: [{ name: 'ZeroAge', visit(node) { if (node.type === 'Literal' && node.value === 18) return [{ replacement: '0' }]; } }] };\n`,
    );
    const report = await runMutation({ root, runner: 'jest', plugins: ['./plugin.js'], concurrency: 1 });
    expect(byStatus(report).Killed).toContain('18 -> 0');
  });

  test('auto picks jest from the jest config', async () => {
    const logs: string[] = [];
    const report = await runMutation({ root, log: (m) => logs.push(m) });
    expect(logs).toContain('runner: jest');
    expect(byStatus(report).Killed).toContain('a + b -> a - b');
  });
});
