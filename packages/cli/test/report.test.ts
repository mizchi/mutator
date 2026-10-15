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
  test('lists at most 20 mutants per kind of gap, and counts the rest', () => {
    const entries = [...Array.from({ length: 30 }, (_, i) => entry(i, 'NoCoverage')), ...Array.from({ length: 5 }, (_, i) => entry(100 + i, 'Survived'))];
    const report: Report = { entries, executed: 35, dryRunFiles: [], scope: 'all', score: 0, durationMs: 1, notRun: { sampled: 0, budget: 0 } };
    const lines = formatSummary(report, '/p').split('\n');
    const listed = lines.filter((l) => l.startsWith('  src/'));
    expect(listed).toHaveLength(25);
    expect(listed.slice(0, 5).every((l) => l.includes('Survived'))).toBe(true);
    expect(lines.at(-1)).toMatch(/10 more .*--reporter json/);
  });

  test('splits undetected mutants by where the test stopped short: detection, infection, reach', () => {
    const entries = [entry(0, 'NoCoverage'), { ...entry(1, 'Survived'), reason: 'notInfected' as const }, entry(2, 'Survived'), entry(3, 'Killed')];
    const report: Report = { entries, executed: 2, dryRunFiles: [], scope: 'all', score: 0.25, durationMs: 1, notRun: { sampled: 0, budget: 0 } };
    const text = formatSummary(report, '/p');
    expect(text).toContain('Killed 1 · Survived 2 (1 not infected) · NoCoverage 1');
    expect(text).toMatch(
      /\nnot detected - tests run it, but none fails:\n  src\/a\.ts:3:1 .*\n\nnot infected - tests run it, but never with a value it changes:\n  src\/a\.ts:2:1 .*\n\nnot reached - no test runs it:\n  src\/a\.ts:1:1 /,
    );
  });

  test('warns about changed test files the runner did not collect', () => {
    const report: Report = { entries: [entry(0, 'Survived')], executed: 1, dryRunFiles: [], scope: 'diff', score: 0, durationMs: 1, notRun: { sampled: 0, budget: 0 }, uncollectedTests: ['test/x.test.ts'] };
    expect(formatSummary(report, '/p')).toContain('warning: test/x.test.ts changed, but the test runner does not collect it');
    expect(formatAnnotations(report, '/p')).toContain('::warning file=test/x.test.ts,title=Test file not collected::');
    expect(formatSummary({ ...report, uncollectedTests: [] }, '/p')).not.toContain('warning:');
  });

  test('warns about skipped tests in the change', () => {
    const report: Report = { entries: [], executed: 0, dryRunFiles: [], scope: 'diff', score: 1, durationMs: 1, notRun: { sampled: 0, budget: 0 }, skippedTests: [{ file: 'test/x.test.ts', line: 3, text: "it.skip('b', () => {" }] };
    expect(formatSummary(report, '/p')).toContain("warning: test/x.test.ts:3 skips a test in the change, so it checks nothing: it.skip('b', () => {");
    expect(formatAnnotations(report, '/p')).toContain('::warning file=test/x.test.ts,line=3,title=Skipped test::');
  });

  test('counts accepted mutants and lists accepted entries that are killed now or gone', () => {
    const entries = [{ ...entry(0, 'Ignored'), accepted: 'equivalent' }, entry(1, 'Killed')];
    const report: Report = { entries, executed: 1, dryRunFiles: [], scope: 'all', score: 1, durationMs: 1, notRun: { sampled: 0, budget: 0 }, acceptance: { killed: ['k1'], stale: ['gone'] } };
    const text = formatSummary(report, '/p');
    expect(text).toContain('accepted: 1 undetected mutant (mutator.accepted.json)');
    expect(text).toMatch(/\naccepted, but detected now - remove from mutator\.accepted\.json:\n  src\/a\.ts:2:1 .*k1/);
    expect(text).toMatch(/\naccepted, but the mutant no longer exists - remove from mutator\.accepted\.json:\n  gone/);
  });

  test('with --only, says the mutants were selected', () => {
    const report: Report = { entries: [{ ...entry(0, 'Killed'), focus: 'diff' }, entry(1, 'Pending')], executed: 1, dryRunFiles: [], scope: 'diff', score: 1, durationMs: 1, notRun: { sampled: 0, budget: 0 }, selection: 'only' };
    expect(formatSummary(report, '/p')).toContain('mutants: 1 selected with --only (2 in total');
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
    expect(text).toMatch(/not detected - tests run it, but none fails:\n  src\/a\.ts:1:1.*\n\nkilled before, undetected now \(their killing test is gone\):\n  src\/a\.ts:5:1/);
  });
});

describe('formatAnnotations', () => {
  test('with --since, annotates only survivors in the diff or rechecked', () => {
    const entries: ReportEntry[] = [{ ...entry(0, 'Survived'), focus: 'diff' }, { ...entry(1, 'Survived'), source: 'reuse' }, { ...entry(2, 'Survived'), focus: 'recheck' }];
    const report: Report = { entries, executed: 2, dryRunFiles: [], scope: 'diff', score: 0, durationMs: 1, notRun: { sampled: 0, budget: 0 } };
    expect(formatAnnotations(report, '/p').split('\n').map((l) => /line=(\d+)/.exec(l)?.[1])).toEqual(['1', '3']);
  });

  test('says how to accept the mutant if it is equivalent', () => {
    const report: Report = { entries: [entry(0, 'Survived')], executed: 1, dryRunFiles: [], scope: 'all', score: 0, durationMs: 1, notRun: { sampled: 0, budget: 0 } };
    expect(formatAnnotations(report, '/p')).toMatch(/::ArithmeticOperator: a \+ b -> a - b \(if equivalent: mutator accept k0 --reason \.\.\.\)$/);
  });

  test('titles each annotation with the kind of gap; unreached code only with --since', () => {
    const entries: ReportEntry[] = [entry(0, 'Survived'), { ...entry(1, 'Survived'), reason: 'notInfected' }, entry(2, 'NoCoverage')];
    const report: Report = { entries, executed: 2, dryRunFiles: [], scope: 'all', score: 0, durationMs: 1, notRun: { sampled: 0, budget: 0 } };
    const titles = (r: Report) => formatAnnotations(r, '/p').split('\n').map((l) => /title=([^:]+)::/.exec(l)?.[1]);
    expect(titles(report)).toEqual(['Mutant not detected', 'Mutant not infected']);
    const diff: Report = { ...report, scope: 'diff', entries: entries.map((e) => ({ ...e, focus: 'diff' as const })) };
    expect(titles(diff)).toEqual(['Mutant not detected', 'Mutant not infected', 'Mutant not reached']);
  });
});
