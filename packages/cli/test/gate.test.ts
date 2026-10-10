import { describe, expect, test } from 'vitest';
import { qualityGate, scoreLevel } from '../src/gate.ts';
import { formatMutationTestingJson } from '../src/mte-report.ts';
import { formatSummary } from '../src/report.ts';
import type { Report, ReportEntry } from '../src/run.ts';

const thresholds = { high: 80, low: 60, break: null };

function report(score: number, statuses: ReportEntry['status'][] = []): Report {
  const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };
  return {
    entries: statuses.map((status, i) => ({
      mutant: {
        key: `k${i}`,
        file: '/p/a.ts',
        mutator: 'ArithmeticOperator',
        range: { start: 0, end: 1 },
        location,
        original: 'a',
        replacement: 'b',
        scope: { id: 's', hash: 'h', range: { start: 0, end: 1 }, location },
      },
      status,
      source: 'run' as const,
      killedBy: [],
      coveredBy: [],
    })),
    executed: statuses.length,
    dryRunFiles: [],
    scope: 'all',
    score,
    durationMs: 1,
  };
}

describe('scoreLevel', () => {
  test.each([
    [0.8, 'high'],
    [0.95, 'high'],
    [0.799, 'low'],
    [0.6, 'low'],
    [0.599, 'danger'],
  ])('%d -> %s', (score, level) => {
    expect(scoreLevel(score, thresholds)).toBe(level);
  });
});

describe('qualityGate', () => {
  test('passes by default', () => {
    expect(qualityGate(report(0, ['Survived']), { thresholds, failOnSurvived: false })).toEqual([]);
  });

  test('fails below thresholds.break', () => {
    expect(qualityGate(report(0.5), { thresholds: { ...thresholds, break: 60 }, failOnSurvived: false })).toEqual([
      'mutation score 50.0% is below the break threshold 60%',
    ]);
    expect(qualityGate(report(0.6), { thresholds: { ...thresholds, break: 60 }, failOnSurvived: false })).toEqual([]);
  });

  test('fails on survived mutants when asked', () => {
    expect(qualityGate(report(0.5, ['Survived', 'Killed']), { thresholds, failOnSurvived: true })).toEqual(['1 mutant(s) survived (--fail-on-survived)']);
  });
});

describe('thresholds in reports', () => {
  test('text summary labels the score', () => {
    expect(formatSummary(report(0.9), '/p', thresholds)).toContain('score: 90.0% [high]');
    expect(formatSummary(report(0.7), '/p', thresholds)).toContain('score: 70.0% [low]');
    expect(formatSummary(report(0.3), '/p', { high: 40, low: 35, break: null })).toContain('score: 30.0% [danger]');
  });

  test('mte report carries the configured thresholds', () => {
    expect(formatMutationTestingJson(report(1), '/p', { high: 90, low: 70, break: 50 }).thresholds).toEqual({ high: 90, low: 70 });
    expect(formatMutationTestingJson(report(1), '/p').thresholds).toEqual({ high: 80, low: 60 });
  });
});
