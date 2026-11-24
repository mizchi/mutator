import { mkdirSync, symlinkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { Mutant } from '@mizchi/mutator-core';
import { RECURSIVE_READ, emptyDryRun } from '@mizchi/mutator-core';
import { type CliSnapshot, mergeDryRun, planDryRun, testFileHashes } from '../src/coverage-cache.ts';

const root = '/p';
const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };
const mutant = (key: string, scope: string, ignored?: string): Mutant => ({
  key,
  file: `${root}/src/a.ts`,
  mutator: 'StringLiteral',
  range: { start: 0, end: 1 },
  location: loc,
  original: '"x"',
  replacement: '""',
  scope: { id: scope, hash: 'h', range: { start: 0, end: 1 }, location: loc },
  ...(ignored ? { ignored } : {}),
});

describe('planDryRun', () => {
  const observedSnapshot = (): CliSnapshot => ({
    toolVersion: 'v', envHash: 'e', results: [],
    tests: ['a', 'b', 'c'].map((s) => ({ id: `test/${s}.spec.ts#t`, fingerprint: 'f', durationMs: 1 })),
    testFiles: Object.fromEntries(['a', 'b', 'c'].map((s) => [`test/${s}.spec.ts`, 'h'])),
    index: Object.fromEntries(['a', 'b', 'c'].map((s) => [`test/${s}.spec.ts#t`, { module: `test/${s}.spec.ts`, taskId: 't' }])),
    staticByFile: {}, deps: Object.fromEntries(['a', 'b', 'c'].map((s) => [`test/${s}.spec.ts`, ['src/a.ts']])), hits: {},
    scopes: { 'src/a.ts': { identity: { hash: 'before' } } },
    sourceCoverage: { 'src/a.ts#identity': ['test/a.spec.ts#t', 'test/c.spec.ts#t'] },
    sourceCoverageIncomplete: ['test/c.spec.ts#t'],
  });

  test('an edited scope without mutants re-collects its observed and incomplete tests', () => {
    const previous = observedSnapshot();
    const m = mutant('unused', 'identity');
    const sources = new Map([[m.file, { scopes: [m.scope], imports: [], reexports: [] }]]);
    expect(planDryRun({ root, previous, valid: true, testFiles: previous.testFiles, sources, resolve: () => undefined })).toEqual({ all: false, files: ['test/a.spec.ts', 'test/c.spec.ts'], stale: [], impacted: [], affectedTests: ['test/a.spec.ts#t', 'test/c.spec.ts#t'] });
  });

  test('merging a partial run replaces observations of re-collected tests and drops deleted tests', () => {
    const previous = observedSnapshot();
    const dry = emptyDryRun();
    dry.tests = [{ id: 'test/a.spec.ts#new', fingerprint: 'new', durationMs: 1 }];
    dry.sourceCoverage = new Map([['src/a.ts#other', ['test/a.spec.ts#new']]]);
    dry.sourceCoverageIncomplete = new Set();
    const merged = mergeDryRun({ root, previous, dry, dryFiles: new Set(['test/a.spec.ts']), testFiles: { 'test/a.spec.ts': 'new', 'test/b.spec.ts': 'h' }, mutants: [] });
    expect(merged.sourceCoverage).toEqual(new Map([['src/a.ts#other', ['test/a.spec.ts#new']]]));
    expect(merged.sourceCoverageIncomplete).toEqual(new Set());
  });

  test('a new source file has no historical dependencies and conservatively re-collects all E2Es', () => {
    const previous = observedSnapshot();
    const m = { ...mutant('new', 'newFunction'), file: `${root}/src/new.ts` };
    const before = mutant('old', 'identity');
    before.scope.hash = 'before';
    const sources = new Map([[before.file, { scopes: [before.scope], imports: [], reexports: [] }], [m.file, { scopes: [m.scope], imports: [], reexports: [] }]]);
    expect(planDryRun({ root, previous, valid: true, testFiles: previous.testFiles, sources, resolve: () => undefined })).toMatchObject({ files: ['test/a.spec.ts', 'test/b.spec.ts', 'test/c.spec.ts'], stale: ['test/a.spec.ts', 'test/b.spec.ts', 'test/c.spec.ts'] });
  });

  test('a new function in a known source keeps all historical dependents as candidates', () => {
    const previous = observedSnapshot();
    const before = mutant('old', 'identity');
    before.scope.hash = 'before';
    const added = mutant('new', 'newFunction');
    const sources = new Map([[before.file, { scopes: [before.scope, added.scope], imports: [], reexports: [] }]]);
    expect(planDryRun({ root, previous, valid: true, testFiles: previous.testFiles, sources, resolve: () => undefined })).toEqual({ all: false, files: ['test/a.spec.ts', 'test/b.spec.ts', 'test/c.spec.ts'], stale: ['test/a.spec.ts', 'test/b.spec.ts', 'test/c.spec.ts'], impacted: [] });
  });

  test('a scope holding only ignored mutants is not treated as changed', () => {
    const previous: CliSnapshot = {
      toolVersion: 'v',
      envHash: 'e',
      tests: [{ id: 'test/a.test.ts#t', fingerprint: 'f', durationMs: 1 }],
      results: [{ key: 'i1', file: `${root}/src/a.ts`, scopeId: 'onlyIgnored', scopeHash: 'h', status: 'Ignored', killedBy: [], coveredBy: [] }],
      testFiles: { 'test/a.test.ts': 'x' },
      index: { 'test/a.test.ts#t': { module: 'test/a.test.ts', taskId: 't' } },
      staticByFile: {},
      deps: { 'test/a.test.ts': ['src/a.ts'] },
      hits: {},
      scopes: { 'src/a.ts': { onlyIgnored: { hash: 'h' } } },
    };
    const m = mutant('i1', 'onlyIgnored', 'arid: logging');
    const sources = new Map([[m.file, { scopes: [m.scope], imports: [], reexports: [] }]]);
    const plan = planDryRun({ root, previous, valid: true, testFiles: { 'test/a.test.ts': 'x' }, sources, resolve: () => undefined });
    expect(plan).toEqual({ all: false, files: [], stale: [], impacted: [] });
  });
});

describe('testFileHashes with run-time inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutator-inputs-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'test'));
  mkdirSync(join(dir, 'fixtures/cases'), { recursive: true });
  writeFileSync(join(dir, 'test/a.test.ts'), 'a');
  writeFileSync(join(dir, 'test/b.test.ts'), 'b');
  writeFileSync(join(dir, 'fixtures/data.json'), '{"n":1}');
  const files = ['test/a.test.ts', 'test/b.test.ts'];
  const hashes = (inputs: Parameters<typeof testFileHashes>[4]) => testFileHashes(dir, files, {}, new Set(), inputs);

  test('a file a test read changes only that test file\'s hash', () => {
    const reads = { 'test/a.test.ts': ['fixtures/data.json'] };
    const before = hashes({ reads });
    writeFileSync(join(dir, 'fixtures/data.json'), '{"n":2}');
    const after = hashes({ reads });
    expect(after['test/a.test.ts']).not.toBe(before['test/a.test.ts']);
    expect(after['test/b.test.ts']).toBe(before['test/b.test.ts']);
  });

  test('a read directory is keyed on its entries, a missing file on its absence', () => {
    const reads = { 'test/a.test.ts': ['fixtures/cases', 'fixtures/missing.json'] };
    const before = hashes({ reads });
    writeFileSync(join(dir, 'fixtures/cases/one.txt'), '');
    const added = hashes({ reads });
    expect(added['test/a.test.ts']).not.toBe(before['test/a.test.ts']);
    writeFileSync(join(dir, 'fixtures/missing.json'), '');
    expect(hashes({ reads })['test/a.test.ts']).not.toBe(added['test/a.test.ts']);
  });

  test('an environment variable a test read is keyed on its value, unset included', () => {
    const env = { 'test/a.test.ts': ['API_URL'] };
    const unset = hashes({ env, environment: {} });
    const set = hashes({ env, environment: { API_URL: 'http://a' } });
    expect(set['test/a.test.ts']).not.toBe(unset['test/a.test.ts']);
    expect(hashes({ env, environment: { API_URL: 'http://b' } })['test/a.test.ts']).not.toBe(set['test/a.test.ts']);
    expect(hashes({ env, environment: { API_URL: 'http://a', OTHER: 'x' } })).toEqual(set);
  });

  test('listing every variable keys on the whole environment except per-shell ones', () => {
    const env = { 'test/a.test.ts': ['*'] };
    const base = hashes({ env, environment: { A: '1', PWD: '/x', SHLVL: '1' } });
    expect(hashes({ env, environment: { A: '1', PWD: '/y', SHLVL: '2', OLDPWD: '/z' } })).toEqual(base);
    expect(hashes({ env, environment: { A: '2', PWD: '/x', SHLVL: '1' } })['test/a.test.ts']).not.toBe(base['test/a.test.ts']);
    expect(hashes({ env, environment: { A: '1', B: '', PWD: '/x' } })['test/a.test.ts']).not.toBe(base['test/a.test.ts']);
  });

  test('a recursive directory read is keyed on every descendant, a plain one on its entries only', () => {
    mkdirSync(join(dir, 'fixtures/tree/sub'), { recursive: true });
    const plain = { 'test/a.test.ts': ['fixtures/tree'] };
    const recursive = { 'test/a.test.ts': [`fixtures/tree${RECURSIVE_READ}`] };
    const before = { plain: hashes({ reads: plain }), recursive: hashes({ reads: recursive }) };
    writeFileSync(join(dir, 'fixtures/tree/sub/nested.txt'), '');
    expect(hashes({ reads: plain })).toEqual(before.plain);
    expect(hashes({ reads: recursive })['test/a.test.ts']).not.toBe(before.recursive['test/a.test.ts']);
  });

  // Directory symlinks need privileges on Windows.
  test.skipIf(process.platform === 'win32')('a recursive read follows directory symlinks, as readdirSync does, and stops at cycles', () => {
    mkdirSync(join(dir, 'fixtures/tree'), { recursive: true });
    mkdirSync(join(dir, 'fixtures/target'), { recursive: true });
    symlinkSync('../target', join(dir, 'fixtures/tree/link'), 'dir');
    symlinkSync('..', join(dir, 'fixtures/target/up'), 'dir');
    const reads = { 'test/a.test.ts': [`fixtures/tree${RECURSIVE_READ}`] };
    const before = hashes({ reads });
    writeFileSync(join(dir, 'fixtures/target/new.case'), '');
    expect(hashes({ reads })['test/a.test.ts']).not.toBe(before['test/a.test.ts']);
  });

  // Directory symlinks need privileges on Windows.
  test.skipIf(process.platform === 'win32')('retargeting a symlink between two directories the walk already visited changes the key', () => {
    mkdirSync(join(dir, 'fixtures/alias/a'), { recursive: true });
    mkdirSync(join(dir, 'fixtures/alias/b'), { recursive: true });
    writeFileSync(join(dir, 'fixtures/alias/a/x'), '');
    writeFileSync(join(dir, 'fixtures/alias/b/y'), '');
    symlinkSync('a', join(dir, 'fixtures/alias/link'), 'dir');
    const reads = { 'test/a.test.ts': [`fixtures/alias${RECURSIVE_READ}`] };
    const before = hashes({ reads });
    rmSync(join(dir, 'fixtures/alias/link'));
    symlinkSync('b', join(dir, 'fixtures/alias/link'), 'dir');
    expect(hashes({ reads })['test/a.test.ts']).not.toBe(before['test/a.test.ts']);
  });

  test('the project root directory is keyed on its entries', () => {
    for (const reads of [{ 'test/a.test.ts': ['.'] }, { 'test/a.test.ts': [`.${RECURSIVE_READ}`] }]) {
      const before = hashes({ reads });
      writeFileSync(join(dir, `root-${reads['test/a.test.ts']![0]!.length}.case`), '');
      expect(hashes({ reads })['test/a.test.ts']).not.toBe(before['test/a.test.ts']);
    }
  });

  test('directory keys follow entry types and ignore node_modules and .mutator', () => {
    mkdirSync(join(dir, 'fixtures/typed/deep'), { recursive: true });
    writeFileSync(join(dir, 'fixtures/typed/deep/x'), '');
    for (const read of ['fixtures/typed', `fixtures/typed${RECURSIVE_READ}`]) {
      const reads = { 'test/a.test.ts': [read] };
      const target = read === 'fixtures/typed' ? 'fixtures/typed/deep' : 'fixtures/typed/deep/x';
      const before = hashes({ reads });
      mkdirSync(join(dir, 'fixtures/typed/node_modules/.vite'), { recursive: true });
      mkdirSync(join(dir, 'fixtures/typed/deep/.mutator'), { recursive: true });
      expect(hashes({ reads })).toEqual(before);
      // A file replaced by a directory of the same name (or the reverse) is a different listing.
      const wasDirectory = read === 'fixtures/typed';
      rmSync(join(dir, target), { recursive: true });
      if (wasDirectory) writeFileSync(join(dir, target), '');
      else mkdirSync(join(dir, target));
      expect(hashes({ reads })['test/a.test.ts']).not.toBe(before['test/a.test.ts']);
      rmSync(join(dir, 'fixtures/typed/deep'), { recursive: true });
      mkdirSync(join(dir, 'fixtures/typed/deep'));
      writeFileSync(join(dir, 'fixtures/typed/deep/x'), '');
    }
  });

  test.skipIf(process.platform === 'win32')('a literal backslash or `**` in a POSIX name is not a separator or the recursive marker', () => {
    mkdirSync(join(dir, 'fixtures/slash/a'), { recursive: true });
    writeFileSync(join(dir, 'fixtures/slash/a/b'), '');
    const recursive = { 'test/a.test.ts': [`fixtures/slash${RECURSIVE_READ}`] };
    const before = hashes({ reads: recursive });
    rmSync(join(dir, 'fixtures/slash/a/b'));
    writeFileSync(join(dir, 'fixtures/slash/a\\b'), '');
    expect(hashes({ reads: recursive })['test/a.test.ts']).not.toBe(before['test/a.test.ts']);
    const literal = { 'test/a.test.ts': ['fixtures/slash/**'] };
    writeFileSync(join(dir, 'fixtures/slash/**'), '1');
    const one = hashes({ reads: literal });
    writeFileSync(join(dir, 'fixtures/slash/**'), '2');
    expect(hashes({ reads: literal })['test/a.test.ts']).not.toBe(one['test/a.test.ts']);
  });

  test('file contents are keyed on their bytes, apart from the directory and missing markers', () => {
    const reads = { 'test/a.test.ts': ['fixtures/blob.bin'] };
    writeFileSync(join(dir, 'fixtures/blob.bin'), Buffer.from([0x80]));
    const before = hashes({ reads });
    writeFileSync(join(dir, 'fixtures/blob.bin'), Buffer.from([0x81]));
    expect(hashes({ reads })['test/a.test.ts']).not.toBe(before['test/a.test.ts']);
    // A file whose text spells a marker is not the marker.
    const marker = { 'test/a.test.ts': ['fixtures/marker'] };
    const missing = hashes({ reads: marker });
    writeFileSync(join(dir, 'fixtures/marker'), '\0missing');
    expect(hashes({ reads: marker })['test/a.test.ts']).not.toBe(missing['test/a.test.ts']);
  });

  test('listing every variable keys on npm configuration, not on per-invocation npm variables', () => {
    const env = { 'test/a.test.ts': ['*'] };
    const base = hashes({ env, environment: { A: '1', npm_config_feature: 'x', npm_lifecycle_event: 'test', npm_package_version: '1.0.0', VITEST_WORKER_ID: '1' } });
    expect(hashes({ env, environment: { A: '1', npm_config_feature: 'x', npm_lifecycle_event: 'mutate', npm_package_version: '1.0.1', VITEST_WORKER_ID: '2' } })).toEqual(base);
    expect(hashes({ env, environment: { A: '1', npm_config_feature: 'y', npm_lifecycle_event: 'test', npm_package_version: '1.0.0', VITEST_WORKER_ID: '1' } })['test/a.test.ts']).not.toBe(base['test/a.test.ts']);
    expect(hashes({ env, environment: { A: '1', npm_config_feature: 'x', npm_lifecycle_event: 'test', npm_package_version: '1.0.0', VITEST_WORKER_ID: '1', VITEST_MODE: 'x' } })['test/a.test.ts']).not.toBe(base['test/a.test.ts']);
  });

  test('without run-time inputs the hash is unchanged', () => {
    expect(hashes({ reads: {}, env: {} })).toEqual(testFileHashes(dir, files, {}, new Set()));
  });
});
