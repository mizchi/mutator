import { estimatedCost, testFileOf } from '@mizchi/mutator-core';

export interface RunEstimate {
  /** Approximate wall time for mutant execution, excluding discovery, baseline and type checking. */
  durationMs: number;
  workers: number;
  mutants: number;
  historySamples: number;
}

export interface WorkEstimate {
  estimate: RunEstimate;
  costs: ReadonlyMap<string, number>;
  totalCostMs: number;
}

/** Estimate work separately from execution so a progress update only needs completed keys and timings. */
export function estimateWork(jobs: readonly { key: string; tests: readonly string[] }[], options: {
  durations: ReadonlyMap<string, number>;
  fileOverheadMs: number;
  workers: number;
  previous?: ReadonlyMap<string, number>;
}): WorkEstimate {
  const costs = new Map<string, number>();
  let historySamples = 0;
  for (const job of jobs) {
    const previous = options.previous?.get(job.key);
    const historical = previous !== undefined && Number.isFinite(previous) && previous > 0;
    if (historical) historySamples++;
    const files = new Set(job.tests.map(testFileOf)).size;
    const cost = historical ? previous : estimatedCost(job.tests, options.durations) + Math.max(0, options.fileOverheadMs) * files;
    costs.set(job.key, Math.max(1, cost));
  }
  const workers = Math.max(1, options.workers);
  const totalCostMs = [...costs.values()].reduce((a, b) => a + b, 0);
  return { costs, totalCostMs, estimate: { durationMs: totalCostMs / workers, workers, mutants: jobs.length, historySamples } };
}

/**
 * Remaining work: predicted cost not yet run, recalibrated by the accumulated execution time of run
 * jobs (summed over parallel sessions) against their prediction.
 * `skippedCostMs` is the predicted cost of jobs settled without a run (type checking alongside):
 * no longer remaining, and not part of the scale.
 */
export function remainingMs(plan: WorkEstimate, completedCostMs: number, observedWorkMs: number, skippedCostMs = 0): number {
  const remaining = Math.max(0, plan.totalCostMs - completedCostMs - skippedCostMs);
  const scale = completedCostMs > 0 && observedWorkMs > 0 ? observedWorkMs / completedCostMs : 1;
  return remaining * scale / plan.estimate.workers;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return '<1s';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
