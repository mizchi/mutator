// The verdicts of a run, kept twice: as report entries in plan order, and as the results the
// snapshot records, in the order they were decided. Both are written through `Tally` so they
// cannot drift apart.
import { type Mutant, type MutantResult, type MutantStatus, type PlanEntry, type ResultReason, toResult } from '@mizchi/mutator-core';
import type { MergedDryRun } from './coverage-cache.ts';
import type { ReportEntry } from './run.ts';
import type { TypecheckResult } from './typecheck.ts';

/** The snapshot's result for a report entry. `coveredBy` overrides the entry's (an ignored mutant keeps none). */
export function resultOf(entry: ReportEntry, extra: { durationMs?: number; coveredBy?: string[] } = {}): MutantResult {
  return {
    ...toResult(entry.mutant, entry.status, entry.killedBy, extra.coveredBy ?? entry.coveredBy, extra.durationMs),
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.matrix ? { matrix: true as const } : {}),
  };
}

export class Tally {
  /** Report entries, in plan order. */
  readonly report: ReportEntry[] = [];
  /** The results the snapshot records, in the order they were decided. */
  readonly results: MutantResult[] = [];
  /** Mutants left Pending: sampled out (or outside --since), or over the time budget. */
  readonly notRun = { sampled: 0, budget: 0 };

  /** An entry whose verdict comes later (a run, or the type check). */
  hold(index: number, entry: ReportEntry): void {
    this.report[index] = entry;
  }

  /** A verdict: the report entry at `index`, and the snapshot's result (derived from the entry unless given). */
  settle(index: number, entry: ReportEntry, result: MutantResult = resultOf(entry)): void {
    this.report[index] = entry;
    this.results.push(result);
  }

  /** Not run now; keep the coverage so the next run can still select tests for it. */
  skip(index: number, mutant: Mutant, coveredBy: string[]): void {
    this.settle(index, { mutant, status: 'Pending', source: 'skipped', killedBy: [], coveredBy });
  }
}

export type Job = { index: number; entry: Extract<PlanEntry, { kind: 'run' }> };

/**
 * Settle the plan entries decided without running. Mutants to run become jobs; notInfected
 * ones (report indices) wait for the type check.
 */
export function classifyPlan(entries: readonly PlanEntry[], coverage: MergedDryRun['coverage'], inScope: ReadonlyMap<string, 'diff' | 'recheck'> | undefined, sampled: ReadonlySet<string> | undefined) {
  const tally = new Tally();
  const jobs: Job[] = [];
  const notInfected: number[] = [];
  for (const [index, entry] of entries.entries()) {
    const { mutant } = entry;
    const coveredBy = [...(coverage.get(mutant.key) ?? [])];
    // Outside --since or sampled out: left Pending, whether it would run or be decided without running.
    // A recheck is not sampled: it is the only run that notices its killing tests are gone.
    const focus = inScope?.get(mutant.key);
    const sampledOut = sampled !== undefined && !sampled.has(mutant.key) && focus !== 'recheck';
    if ((entry.kind === 'run' || entry.kind === 'notInfected') && ((inScope && !focus) || sampledOut)) {
      if (!inScope || focus) tally.notRun.sampled++;
      tally.skip(index, mutant, coveredBy);
      continue;
    }
    switch (entry.kind) {
      case 'ignored':
      case 'noCoverage': {
        const status = entry.kind === 'ignored' ? 'Ignored' : 'NoCoverage';
        const settled: ReportEntry = { mutant, status, source: 'static', killedBy: [], coveredBy };
        tally.settle(index, settled, resultOf(settled, { coveredBy: [] }));
        break;
      }
      case 'notInfected':
        // Covered, but no covering test reaches it with a different value: it cannot be
        // killed. Decided after type checking (an uncompilable mutant is a CompileError).
        notInfected.push(index);
        tally.hold(index, { mutant, status: 'Survived', source: 'static', killedBy: [], coveredBy, reason: 'notInfected' });
        break;
      case 'reuse': {
        // Keep the cached verdict but record today's coverage: new covering tests must not be lost.
        const { result } = entry;
        tally.settle(index, { mutant, status: result.status, source: 'reuse', killedBy: result.killedBy, coveredBy, ...(result.reason ? { reason: result.reason } : {}), ...(result.matrix ? { matrix: true as const } : {}) }, { ...result, coveredBy });
        break;
      }
      case 'run':
        jobs.push({ index, entry });
        tally.hold(index, { mutant, status: 'Pending', source: 'run', killedBy: [], coveredBy });
        break;
    }
  }
  return { tally, jobs, notInfected };
}

/**
 * Uncompilable mutants become CompileError, those proven equivalent by types Ignored (both
 * leave `jobs`); the other notInfected ones are settled Survived.
 */
export function applyTypecheck(tally: Tally, jobs: Job[], notInfected: readonly number[], { errors, equivalent }: TypecheckResult): void {
  const decided = (key: string): { status: MutantStatus; reason?: ResultReason } | undefined => {
    if (errors.has(key)) return { status: 'CompileError' };
    const reason = equivalent.get(key);
    return reason === undefined ? undefined : { status: 'Ignored', reason };
  };
  for (const i of notInfected) {
    const entry = tally.report[i]!;
    const verdict = decided(entry.mutant.key);
    const { reason: _reason, ...rest } = entry;
    // Coverage is kept even for CompileError: a later run that skips this test file still needs it.
    tally.settle(i, verdict ? { ...rest, ...verdict } : entry);
  }
  for (let i = jobs.length - 1; i >= 0; i--) {
    const { index, entry } = jobs[i]!;
    const verdict = decided(entry.mutant.key);
    if (!verdict) continue;
    tally.settle(index, { mutant: entry.mutant, source: 'static', killedBy: [], coveredBy: tally.report[index]!.coveredBy, ...verdict });
    jobs.splice(i, 1);
  }
}
