import type { Thresholds } from './config.ts';
import { criticalSummary } from './critical.ts';
import type { Report, ReportEntry } from './run.ts';

export type ScoreLevel = 'high' | 'low' | 'danger';

export function scoreLevel(score: number, { high, low }: Pick<Thresholds, 'high' | 'low'>): ScoreLevel {
  const percent = score * 100;
  return percent >= high ? 'high' : percent >= low ? 'low' : 'danger';
}

/** The entries a run reports on: with --since, those in the diff and the rechecked ones. */
export function reported(report: Report): ReportEntry[] {
  return report.scope === 'diff' ? report.entries.filter((e) => e.focus) : report.entries;
}

/** Reasons the run fails the quality gate (exit 2); empty when it passes. */
export function qualityGate(report: Report, options: { thresholds: Thresholds; failOnSurvived: boolean }): string[] {
  const failures: string[] = [];
  const percent = report.score * 100;
  const { break: breakAt } = options.thresholds;
  if (breakAt !== null && percent < breakAt) failures.push(`mutation score ${percent.toFixed(1)}% is below the break threshold ${breakAt}%`);
  // Possibly reached in a child process: still listed, but not counted.
  const childProcess = new Set(report.childProcessMutants);
  const survived = reported(report).filter((e) => e.status === 'Survived' && !childProcess.has(e.mutant.key)).length;
  if (options.failOnSurvived && survived > 0) failures.push(`${survived} mutant(s) survived (--fail-on-survived)`);
  // Critical regions fail regardless of the thresholds and flags, child-process mutants included.
  const critical = criticalSummary(report)?.undetected.length ?? 0;
  if (critical > 0) failures.push(`${critical} undetected mutant(s) in critical regions: each must be killed or accepted`);
  return failures;
}
