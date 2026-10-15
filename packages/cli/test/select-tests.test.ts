import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MutantResult } from '@mizchi/mutator-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runMutation } from '../src/run.ts';
import { type Picked, type SelectionInput, selectTests, selectionFiles } from '../src/select-tests.ts';

const root = '/p';
let n = 0;
const result = (file: string, scopeId: string, status: MutantResult['status'], killedBy: string[], coveredBy: string[]): MutantResult => ({
  key: `k${n++}`,
  file: `${root}/${file}`,
  scopeId,
  scopeHash: 'old',
  status,
  killedBy,
  coveredBy,
});

const A1 = 'test/a.test.ts#double';
const A2 = 'test/a.test.ts#combo';
const B1 = 'test/b.test.ts#greet';
const C1 = 'test/c.test.ts#other';

const base = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  root,
  results: [
    result('src/a.ts', 'double', 'Killed', [A1], [A1, A2]),
    result('src/a.ts', 'double', 'Killed', [A1], [A1, A2]),
    result('src/a.ts', 'double', 'Killed', [A2], [A1, A2]),
    result('src/a.ts', 'double', 'Survived', [], [A1, A2, B1]),
    result('src/a.ts', 'isPositive', 'Killed', [C1], [C1]),
    result('src/b.ts', 'greet', 'Killed', [B1], [B1]),
  ],
  tests: [A1, A2, B1, C1].map((id) => ({ id })),
  scopes: new Map([[`${root}/src/a.ts`, new Set(['double'])]]),
  changed: ['src/a.ts'],
  sources: new Set(['src/a.ts', 'src/b.ts', 'src/new.ts']),
  testFiles: { 'test/a.test.ts': 'h', 'test/b.test.ts': 'h', 'test/c.test.ts': 'h' },
  deps: { 'test/a.test.ts': ['src/a.ts', 'test/helper.ts'], 'test/b.test.ts': ['src/b.ts'], 'test/c.test.ts': ['src/a.ts'] },
  ...over,
});

describe('selectTests', () => {
  test('ranks killers of mutants in the changed scopes by kills, then the other covering tests', () => {
    const selection = selectTests(base());
    expect(selection.killers).toEqual([
      { test: A1, file: 'test/a.test.ts', kills: 2, covers: 4, reason: 'killed 2 mutants in src/a.ts#double' },
      { test: A2, file: 'test/a.test.ts', kills: 1, covers: 4, reason: 'killed 1 mutant in src/a.ts#double' },
    ]);
    expect(selection.covering).toEqual([{ test: B1, file: 'test/b.test.ts', covers: 1, reason: 'covers 1 mutant in src/a.ts#double' }]);
    expect(selection.changedTests).toEqual([]);
    // Unchanged scopes (isPositive) bring nothing.
    expect(selectionFiles(selection)).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });

  test('matches scopes by file and id, not by hash (changed code has a new hash)', () => {
    const selection = selectTests(base());
    expect(selection.killers.map((p) => p.test)).toEqual([A1, A2]);
  });

  test('tests no longer collected are left out', () => {
    const selection = selectTests(base({ tests: [A2, B1, C1].map((id) => ({ id })) }));
    expect(selection.killers.map((p) => p.test)).toEqual([A2]);
  });

  test('changed test files come last; a changed helper brings the test files importing it', () => {
    const selection = selectTests(base({ changed: ['src/a.ts', 'test/c.test.ts', 'test/new.test.ts', 'test/helper.ts', 'README.md'] }));
    expect(selection.changedTests).toEqual([
      { file: 'test/c.test.ts', reason: 'changed' },
      { file: 'test/new.test.ts', reason: 'changed' },
      { file: 'test/a.test.ts', reason: 'imports test/helper.ts' },
    ]);
    expect(selectionFiles(selection)).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/new.test.ts']);
  });

  test('a changed scope without snapshot data falls back to the test files importing its file', () => {
    const selection = selectTests(
      base({
        scopes: new Map([[`${root}/src/b.ts`, new Set(['shout'])]]),
        changed: ['src/b.ts'],
      }),
    );
    expect(selection.killers).toEqual([]);
    expect(selection.covering).toEqual([{ file: 'test/b.test.ts', reason: 'imports src/b.ts (no snapshot data for shout)' }]);
  });

  test('a new source file nothing imported yet selects nothing', () => {
    const selection = selectTests(base({ scopes: new Map([[`${root}/src/new.ts`, new Set(['f'])]]), changed: ['src/new.ts'] }));
    expect(selectionFiles(selection)).toEqual([]);
  });

  test('a test file already selected for its tests is not repeated in the file list', () => {
    const selection = selectTests(base({ changed: ['src/a.ts', 'test/a.test.ts'] }));
    expect(selection.changedTests).toEqual([{ file: 'test/a.test.ts', reason: 'changed' }]);
    expect(selectionFiles(selection)).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });
});

describe('mutator select-tests', { timeout: 60_000 }, () => {
  const cli = join(import.meta.dirname, '../src/cli.ts');
  const fixture = join(import.meta.dirname, 'fixtures/multi');
  // Inside the workspace so the fixture resolves `vitest` from the root node_modules.
  const tmpRoot = join(import.meta.dirname, '../../../.tmp');
  let dir: string;
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, '--root', dir], { encoding: 'utf8' });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const edit = (rel: string, from: string, to: string) => writeFileSync(join(dir, rel), readFileSync(join(dir, rel), 'utf8').replace(from, to));

  beforeEach(() => {
    mkdirSync(tmpRoot, { recursive: true });
    dir = join(tmpRoot, `select-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '.mutator/\n');
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('without a snapshot, exits 1 asking for a run first', () => {
    const { status, stdout, stderr } = run('select-tests', '--since', 'HEAD');
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/no snapshot at .*run `mutator` once first/);
  });

  test('after a run, an edited function selects the tests that killed its mutants, without running anything', async () => {
    await runMutation({ root: dir, concurrency: 1 });
    edit('src/a.ts', 'return n * 2;', 'return n + n;');
    const snapshot = readFileSync(join(dir, '.mutator/snapshot.json'), 'utf8');

    const files = run('select-tests', '--since', 'HEAD');
    expect(files.status, files.stderr).toBe(0);
    expect(files.stdout).toBe('test/a.test.ts\n');

    const json = run('select-tests', '--since', 'HEAD', '--format', 'json');
    expect(json.status, json.stderr).toBe(0);
    const selection = JSON.parse(json.stdout);
    expect(selection.files).toEqual(['test/a.test.ts']);
    // `double` runs first and stops each run: `combo` only covers (killedBy keeps the first killer).
    expect(selection.killers.map((p: Picked) => p.test)).toEqual(['test/a.test.ts#double']);
    expect(selection.covering.map((p: Picked) => p.test)).toEqual(['test/a.test.ts#combo']);
    expect(selection.killers[0].reason).toMatch(/^killed \d+ mutants? in src\/a\.ts#double$/);
    expect(selection.changedTests).toEqual([]);
    // Nothing ran: the snapshot is untouched.
    expect(readFileSync(join(dir, '.mutator/snapshot.json'), 'utf8')).toBe(snapshot);

    // A changed test file comes last.
    edit('test/b.test.ts', "expect(greet('a'))", "expect(greet('b')).toBe('hello b');\n  expect(greet('a'))");
    expect(run('select-tests', '--since', 'HEAD').stdout).toBe('test/a.test.ts\ntest/b.test.ts\n');
  });

  test('a snapshot from another environment exits 1', async () => {
    await runMutation({ root: dir, concurrency: 1 });
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    const { status, stderr } = run('select-tests', '--since', 'HEAD');
    expect(status).toBe(1);
    expect(stderr).toContain('is from another environment');
    expect(stderr).toContain('run `mutator` once first');
  });

  test('rejects an unknown format and a missing --since', () => {
    expect(run('select-tests', '--since', 'HEAD', '--format', 'vitest').stderr).toContain('--format must be one of files, json');
    expect(run('select-tests').stderr).toContain('--since <ref> is required');
  });
});
