import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Mutant } from '@mizchi/mutator-core';
import { formatAgentReport } from '../src/agent-report.ts';
import type { Report, ReportEntry } from '../src/run.ts';

const root = mkdtempSync(join(tmpdir(), 'mutator-agent-'));
const source = 'export function isAdult(age: number): boolean {\n  return age >= 18;\n}\n';
writeFileSync(join(root, 'a.ts'), source);
const start = source.indexOf('age >= 18');
const mutant = {
  key: 'k1',
  file: join(root, 'a.ts'),
  mutator: 'EqualityOperator',
  range: { start, end: start + 9 },
  location: { start: { line: 2, column: 9 }, end: { line: 2, column: 18 } },
  original: 'age >= 18',
  replacement: 'age > 18',
  scope: { id: 'isAdult', hash: 'h', range: { start: 0, end: source.length - 1 }, location: { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } } },
} as Mutant;
const entry = (status: ReportEntry['status'], extra: Partial<ReportEntry> = {}): ReportEntry => ({ mutant, status, source: 'run', killedBy: [], coveredBy: ['a.test.ts#adult'], ...extra });

test('one record per undetected mutant, with the gap, the code around it and how to fix it', () => {
  const report: Report = {
    entries: [entry('Survived', { reason: 'notInfected', focus: 'diff' }), entry('Killed', { focus: 'diff', mutant: { ...mutant, key: 'k2' } }), entry('Survived', { mutant: { ...mutant, key: 'k3' } })],
    executed: 1, dryRunFiles: [], scope: 'diff', score: 0.5, durationMs: 1, notRun: { sampled: 0, budget: 0 },
    uncollectedTests: ['x.test.ts'],
    skippedTests: [{ file: 'x.test.ts', line: 2, text: 'it.skip(' }],
  };
  const out = formatAgentReport(report, root);
  expect(out).toMatchObject({ version: 1, scope: 'diff', score: 0.5, counts: { Survived: 1, Killed: 1 } });
  expect(out.gaps).toEqual([
    {
      key: 'k1',
      gap: 'notInfected',
      file: 'a.ts',
      line: 2,
      column: 10,
      mutator: 'EqualityOperator',
      original: 'age >= 18',
      replacement: 'age > 18',
      scope: { id: 'isAdult', startLine: 1, endLine: 3, source: source.trimEnd() },
      coveredBy: ['a.test.ts#adult'],
      coveredByCount: 1,
      fix: expect.stringContaining('input'),
    },
  ]);
  expect(out.warnings).toEqual([
    { kind: 'uncollectedTest', file: 'x.test.ts', message: expect.any(String) },
    { kind: 'skippedTest', file: 'x.test.ts', line: 2, message: expect.stringContaining('it.skip(') },
  ]);
});

test('flags gaps possibly reached in a child process, and warns about the spawning tests', () => {
  const report: Report = {
    entries: [entry('NoCoverage'), entry('Survived', { mutant: { ...mutant, key: 'k2' } })],
    executed: 1, dryRunFiles: [], scope: 'all', score: 0, durationMs: 1, notRun: { sampled: 0, budget: 0 },
    childProcessTests: [{ test: 'cli.test.ts#runs', command: 'node a.js' }],
    childProcessMutants: ['k1'],
  };
  const out = formatAgentReport(report, root);
  expect(out.gaps.map((g) => [g.key, g.childProcess])).toEqual([['k1', true], ['k2', undefined]]);
  expect(out.warnings).toEqual([{ kind: 'childProcessTest', test: 'cli.test.ts#runs', command: 'node a.js', message: expect.stringContaining('child process') }]);
});

test('long scopes are cut to the lines around the mutant', () => {
  const big = { ...mutant, scope: { ...mutant.scope, location: { start: { line: 1, column: 0 }, end: { line: 500, column: 1 } } } };
  writeFileSync(join(root, 'big.ts'), Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n'));
  const report: Report = { entries: [entry('Survived', { mutant: { ...big, file: join(root, 'big.ts'), location: { start: { line: 250, column: 0 }, end: { line: 250, column: 4 } } } })], executed: 1, dryRunFiles: [], scope: 'all', score: 0, durationMs: 1, notRun: { sampled: 0, budget: 0 } };
  const { scope } = formatAgentReport(report, root).gaps[0]!;
  expect([scope.startLine, scope.endLine]).toEqual([210, 290]);
  expect(scope.source.split('\n')[0]).toBe('line 210');
});

test('covering tests are capped, those naming the function first', () => {
  const coveredBy = [...Array.from({ length: 20 }, (_, i) => `other.test.ts#case ${i}`), 'a.test.ts#isAdult > boundary'];
  const report: Report = { entries: [entry('Survived', { coveredBy })], executed: 1, dryRunFiles: [], scope: 'all', score: 0, durationMs: 1, notRun: { sampled: 0, budget: 0 } };
  const gap = formatAgentReport(report, root).gaps[0]!;
  expect(gap.coveredBy).toHaveLength(10);
  expect(gap.coveredBy[0]).toBe('a.test.ts#isAdult > boundary');
  expect(gap.coveredByCount).toBe(21);
});

test('marks covered survivors of removals as simplification candidates, with the kind of removal', () => {
  const removal = (key: string, status: ReportEntry['status'], mutator: string, original: string, replacement: string) => entry(status, { mutant: { ...mutant, key, mutator, original, replacement } });
  const report: Report = {
    entries: [
      removal('guard', 'Survived', 'ConditionalExpression', 'age >= 18', 'true'),
      removal('unreached', 'NoCoverage', 'ConditionalExpression', 'age >= 18', 'false'),
      entry('Survived', { mutant: { ...mutant, key: 'value' } }),
    ],
    executed: 2, dryRunFiles: [], scope: 'all', score: 0, durationMs: 1, notRun: { sampled: 0, budget: 0 },
  };
  expect(formatAgentReport(report, root).gaps.map((g) => [g.key, g.simplify])).toEqual([['guard', 'condition'], ['unreached', undefined], ['value', undefined]]);
});
