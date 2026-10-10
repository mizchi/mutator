import { describe, expect, test } from 'vitest';
import type { Mutant } from '@mizchi/mutator-core';
import { type CliSnapshot, planDryRun } from '../src/coverage-cache.ts';

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
