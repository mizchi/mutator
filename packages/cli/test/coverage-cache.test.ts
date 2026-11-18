import { describe, expect, test } from 'vitest';
import type { Mutant } from '@mizchi/mutator-core';
import { emptyDryRun } from '@mizchi/mutator-core';
import { type CliSnapshot, mergeDryRun, planDryRun } from '../src/coverage-cache.ts';

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
