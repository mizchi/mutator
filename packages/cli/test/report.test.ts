import { describe, expect, test } from 'vitest';
import type { Mutant } from '@mizchi/mutator-core';
import { formatAnnotations, formatSummary } from '../src/report.ts';
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
    const report: Report = { entries, executed: 35, dryRunFiles: [], scope: 'all', score: 0, durationMs: 1, notRun: { sampled: 0, budget: 0 } };
    const lines = formatSummary(report, '/p').split('\n');
    const listed = lines.filter((l) => l.startsWith('  src/'));
    expect(listed).toHaveLength(20);
    expect(listed.slice(0, 5).every((l) => l.includes('Survived'))).toBe(true);
    expect(lines.at(-1)).toMatch(/15 more undetected .*--reporter json/);
  });

  test('says how many mutants were not run because of sampling or the time budget', () => {
    const entries = [entry(0, 'Killed'), entry(1, 'Pending'), entry(2, 'Pending'), entry(3, 'Pending')];
    const report: Report = { entries, executed: 1, dryRunFiles: [], scope: 'diff', score: 1, durationMs: 1, notRun: { sampled: 2, budget: 1 } };
    expect(formatSummary(report, '/p')).toContain('not run: 2 sampled out (--mutants-per-line), 1 over the time budget (--time-budget)');
    expect(formatSummary({ ...report, notRun: { sampled: 0, budget: 1 } }, '/p')).toContain('not run: 1 over the time budget (--time-budget)');
    expect(formatSummary({ ...report, notRun: { sampled: 0, budget: 0 } }, '/p')).not.toContain('not run');
  });

  test('with --since, counts and lists only the changed code, and rechecks apart', () => {
    const entries: ReportEntry[] = [
      { ...entry(0, 'Survived'), focus: 'diff' },
      { ...entry(1, 'Killed'), focus: 'diff' },
      { ...entry(2, 'Survived'), source: 'reuse' },
      { ...entry(3, 'NoCoverage'), source: 'reuse' },
      { ...entry(4, 'Survived'), focus: 'recheck' },
      { ...entry(5, 'Killed'), focus: 'recheck' },
    ];
    const report: Report = { entries, executed: 3, dryRunFiles: [], scope: 'diff', score: 0.5, durationMs: 1, notRun: { sampled: 0, budget: 0 } };
    const text = formatSummary(report, '/p');
    expect(text).toContain('mutants: 2 in the diff, 2 rechecked (6 in total; executed 3, reused 2)');
    expect(text).toContain('Killed 1 · Survived 1\n');
    const listed = text.split('\n').filter((l) => l.startsWith('  src/'));
    expect(listed).toEqual([expect.stringMatching(/^  src\/a\.ts:1:1 +Survived/), expect.stringMatching(/^  src\/a\.ts:5:1 +Survived/)]);
    expect(text).toMatch(/undetected:\n  src\/a\.ts:1:1.*\n\nkilled before, undetected now \(their killing test is gone\):\n  src\/a\.ts:5:1/);
  });
});

describe('formatAnnotations', () => {
  test('with --since, annotates only survivors in the diff or rechecked', () => {
    const entries: ReportEntry[] = [{ ...entry(0, 'Survived'), focus: 'diff' }, { ...entry(1, 'Survived'), source: 'reuse' }, { ...entry(2, 'Survived'), focus: 'recheck' }];
    const report: Report = { entries, executed: 2, dryRunFiles: [], scope: 'diff', score: 0, durationMs: 1, notRun: { sampled: 0, budget: 0 } };
    expect(formatAnnotations(report, '/p').split('\n').map((l) => /line=(\d+)/.exec(l)?.[1])).toEqual(['1', '3']);
  });
});
