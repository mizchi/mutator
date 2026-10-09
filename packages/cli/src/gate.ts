import type { Thresholds } from './config.ts';
import type { Report } from './run.ts';

export type ScoreLevel = 'high' | 'low' | 'danger';

export function scoreLevel(score: number, { high, low }: Pick<Thresholds, 'high' | 'low'>): ScoreLevel {
  const percent = score * 100;
  return percent >= high ? 'high' : percent >= low ? 'low' : 'danger';
}

/** Reasons the run fails the quality gate (exit 2); empty when it passes. */
export function qualityGate(report: Report, options: { thresholds: Thresholds; failOnSurvived: boolean }): string[] {
  const failures: string[] = [];
  const percent = report.score * 100;
  const { break: breakAt } = options.thresholds;
  if (breakAt !== null && percent < breakAt) failures.push(`mutation score ${percent.toFixed(1)}% is below the break threshold ${breakAt}%`);
  const survived = report.entries.filter((e) => e.status === 'Survived').length;
  if (options.failOnSurvived && survived > 0) failures.push(`${survived} mutant(s) survived (--fail-on-survived)`);
  return failures;
}
