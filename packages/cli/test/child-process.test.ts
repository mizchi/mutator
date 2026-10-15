import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { childProcessReach, possiblyInChildProcess, spawnedEntries } from '../src/child-process.ts';
import { type Report, type ReportEntry, importResolver, runMutation } from '../src/run.ts';

const root = mkdtempSync(join(tmpdir(), 'mutator-spawn-'));
for (const dir of ['src', 'bin', 'node_modules/tool']) mkdirSync(join(root, dir), { recursive: true });
const files: Record<string, string> = {
  'src/cli.js': "import { greet } from './greet.js';\nconsole.log(greet());\n",
  'src/greet.js': "export { name } from './name.js';\nexport const greet = () => 'hi';\n",
  'src/name.js': "export const name = 'x';\n",
  'src/other.js': 'export const other = 1;\n',
  'bin/run.js': "import '../src/cli.js';\n",
  'node_modules/tool/index.js': "import '../../src/other.js';\n",
};
for (const [file, source] of Object.entries(files)) writeFileSync(join(root, file), source);

describe('spawnedEntries', () => {
  test('arguments naming files inside the root, relative to the working directory', () => {
    expect(spawnedEntries(root, { argv: ['node', 'src/cli.js', 'x'], cwd: root })).toEqual(['src/cli.js']);
    expect(spawnedEntries(root, { argv: ['node', '../bin/run.js'], cwd: join(root, 'src') })).toEqual(['bin/run.js']);
    expect(spawnedEntries(root, { argv: [join(root, 'bin/run.js')], cwd: tmpdir() })).toEqual(['bin/run.js']);
  });

  test('ignores flags, directories, missing files, node_modules and files outside the root', () => {
    expect(spawnedEntries(root, { argv: ['git', 'status', 'src', '--flag', 'node_modules/tool/index.js', join(tmpdir(), 'x.js')], cwd: root })).toEqual([]);
  });
});

describe('childProcessReach', () => {
  test('the spawning tests and the local files their entries load', () => {
    const reach = childProcessReach({
      root,
      spawns: new Map([
        ['test/cli.test.ts#runs', [{ argv: ['node', 'bin/run.js'], cwd: root }, { argv: ['git', 'status'], cwd: root }]],
        ['test/git.test.ts#git', [{ argv: ['git', 'init'], cwd: root }]],
      ]),
      resolve: importResolver([], true),
    });
    expect(reach.tests).toEqual([{ test: 'test/cli.test.ts#runs', command: 'node bin/run.js' }]);
    expect([...reach.files].sort()).toEqual(['bin/run.js', 'src/cli.js', 'src/greet.js', 'src/name.js']);
  });
});

describe('runMutation with a test running the sources in a child process', { timeout: 60_000 }, () => {
  const fixture = fileURLToPath(new URL('./fixtures/spawn', import.meta.url));
  // Inside the workspace so the fixture resolves `vitest` from the root node_modules.
  const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));
  let project: string;
  beforeEach(() => {
    mkdirSync(tmpRoot, { recursive: true });
    project = join(tmpRoot, `spawn-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, project, { recursive: true });
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test('labels the mutants the spawned entry loads, also when the dry run is reused', async () => {
    const labelled = (report: Report) => report.entries.filter((e) => report.childProcessMutants?.includes(e.mutant.key)).map((e) => relative(project, e.mutant.file));
    const first = await runMutation({ root: project, concurrency: 1 });
    expect(first.childProcessTests).toEqual([{ test: 'test/cli.test.ts#greets', command: 'node src/cli.js x' }]);
    expect(new Set(labelled(first))).toEqual(new Set(['src/greet.js']));
    const sub = first.entries.find((e) => e.mutant.original === 'a - b')!;
    expect(sub.status).toBe('NoCoverage');
    expect(first.childProcessMutants).not.toContain(sub.mutant.key);

    const second = await runMutation({ root: project, concurrency: 1 });
    expect(second.dryRunFiles).toEqual([]);
    expect(second.childProcessTests).toEqual(first.childProcessTests);
    expect(second.childProcessMutants).toEqual(first.childProcessMutants);
  });
});

describe('possiblyInChildProcess', () => {
  const entry = (key: string, file: string, status: ReportEntry['status']) =>
    ({ mutant: { key, file: join(root, file) }, status, source: 'run', killedBy: [], coveredBy: [] }) as unknown as ReportEntry;

  test('undetected mutants in the files a child process may run', () => {
    const entries = [entry('a', 'src/greet.js', 'NoCoverage'), entry('b', 'src/greet.js', 'Survived'), entry('c', 'src/greet.js', 'Killed'), entry('d', 'src/other.js', 'NoCoverage'), entry('e', 'src/greet.js', 'Ignored')];
    expect(possiblyInChildProcess(entries, new Set(['src/greet.js']), root)).toEqual(['a', 'b']);
  });
});
