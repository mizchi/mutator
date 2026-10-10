import { describe, expect, test } from 'vitest';
import type { Mutant } from '@mizchi/mutator-core';
import { formatSummary } from '../src/report.ts';
import type { Report, ReportEntry } from '../src/run.ts';

const entry = (i: number, status: ReportEntry['status']): ReportEntry => ({
  mutant: { key: `k${i}`, file: '/p/src/a.ts', mutator: 'ArithmeticOperator', range: { start: i, end: i + 1 }, location: { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 1 } }, original: 'a + b', replacement: 'a - b', scope: { id: 'f', hash: 'h', range: { start: 0, end: 1 }, location: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } } } as Mutant,
  status,
  source: 'run',
  killedBy: [],
  coveredBy: [],
});

describe('formatSummary', () => {
  test('lists at most 20 undetected mutants, survivors first, and counts the rest', () => {
    const entries = [...Array.from({ length: 30 }, (_, i) => entry(i, 'NoCoverage')), ...Array.from({ length: 5 }, (_, i) => entry(100 + i, 'Survived'))];
    const report: Report = { entries, executed: 35, dryRunFiles: [], scope: 'all', score: 0, durationMs: 1 };
    const lines = formatSummary(report, '/p').split('\n');
    const listed = lines.filter((l) => l.startsWith('  src/'));
    expect(listed).toHaveLength(20);
    expect(listed.slice(0, 5).every((l) => l.includes('Survived'))).toBe(true);
    expect(lines.at(-1)).toMatch(/15 more undetected .*--reporter json/);
  });
});
