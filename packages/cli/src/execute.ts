// Running the mutants that need a run, over parallel runner sessions and within the time budget.
import { availableParallelism } from 'node:os';
import { relative } from 'node:path';
import { type Session, estimatedCost, orderByCost } from '@mizchi/mutator-core';
import type { MergedDryRun } from './coverage-cache.ts';
import { oneLine } from './report.ts';
import type { ReportEntry } from './run.ts';
import { type Runner, type RunnerSessionOptions, createRunnerSession } from './runner.ts';
import { runSharded, splitByFile } from './shard.ts';
import { type Job, type Tally, resultOf } from './tally.ts';
import { RetryCounts, type TimeoutRetries, runWithTimeoutRetry } from './timeout-retry.ts';

/** Runs longer than this (estimated from the dry run) are split by test file. */
const SHARD_TARGET_MS = 10_000;

export interface ExecuteContext {
  root: string;
  log: (message: string) => void;
  runner: Runner;
  sessionOptions: RunnerSessionOptions;
  /** The dry run's session; parallel sessions created here are added to `sessions` for closing. */
  session: Session;
  sessions: Session[];
  merged: MergedDryRun;
  /** Start of the run, for the time budget. */
  started: number;
  timeBudget: number | undefined;
  concurrency: number | undefined;
  /** No early exit: every covering test runs, kills are recorded as a full matrix. */
  killMatrix: boolean;
}

/**
 * Run the jobs over parallel sessions; those over the time budget are skipped. Returns how many
 * ran, and how many runs timed out and were re-run with a longer budget (`confirmed`: timed out again).
 */
export async function executeJobs(jobs: Job[], tally: Tally, ctx: ExecuteContext): Promise<{ executed: number; timeoutRetries: TimeoutRetries; runtimeErrorRetries: TimeoutRetries }> {
  const { root, log, merged, timeBudget } = ctx;
  const { report, notRun } = tally;
  const testDurations = new Map(merged.tests.map((t) => [t.id, t.durationMs]));
  // Under a budget, cheapest first: the budget then settles as many mutants as possible.
  if (timeBudget !== undefined) jobs.splice(0, jobs.length, ...orderByCost(jobs, (j) => estimatedCost(j.entry.tests, testDurations), (j) => j.entry.mutant.key));
  // Long runs (typically static mutants, which run every test file that loaded them) are
  // split by test file so idle sessions can take part of them.
  const sharded = jobs.map((job) => ({ ...job, shards: splitByFile(job.entry.tests, testDurations, SHARD_TARGET_MS) }));
  const shardCount = sharded.reduce((n, j) => n + j.shards.length, 0);
  const concurrency = Math.max(1, Math.min(ctx.concurrency ?? defaultConcurrency(), shardCount));
  // In parallel mode every mutant session gets a single worker so sessions do not
  // oversubscribe the CPU; a lone session keeps the runner's default workers.
  const workers = concurrency === 1 ? [ctx.session] : await Promise.all(Array.from({ length: concurrency }, () => createRunnerSession(ctx.runner, { ...ctx.sessionOptions, maxWorkers: 1 })));
  if (concurrency > 1) ctx.sessions.push(...workers);
  for (const s of workers) s.useTestIndex(merged.index);
  const deadline = timeBudget !== undefined ? ctx.started + timeBudget * 1000 : Infinity;
  let executed = 0;
  const retries = new RetryCounts();
  const unsettled = await runSharded({
    workers: workers.length,
    jobs: sharded,
    shouldStop: () => performance.now() >= deadline,
    allShards: ctx.killMatrix,
    // A shard keeps its job's timeout: test durations leave out module loading, so a
    // proportional share is too tight for shards of many files. Loops are caught by the stall timer.
    run: async (worker, { entry }, tests) => {
      const options = {
        timeoutMs: entry.timeoutMs,
        stallMs: stallBudget(tests, testDurations),
        isStatic: entry.isStatic,
        hitLimit: Math.max(10_000, (merged.hits.get(entry.mutant.key) ?? 0) * 100),
        ...(ctx.killMatrix ? { earlyExit: false } : {}),
      };
      const { outcome, retried } = await runWithTimeoutRetry((o) => workers[worker]!.runMutant(entry.mutant.key, [...tests], o), options);
      const message = retries.count(retried, outcome.status);
      if (message) log(`${message}: ${outcome.status} ${relative(root, entry.mutant.file)}:${entry.mutant.location.start.line}`);
      return outcome;
    },
    onDone: ({ index, entry }, outcome) => {
      const { mutant } = entry;
      executed++;
      log(`[${executed}/${jobs.length}] ${outcome.status.padEnd(8)} ${relative(root, mutant.file)}:${mutant.location.start.line} ${oneLine(mutant.original)} -> ${oneLine(mutant.replacement)}`);
      const matrix = ctx.killMatrix && outcome.status === 'Killed' ? { matrix: true as const } : {};
      const settled: ReportEntry = { mutant, status: outcome.status, source: 'run', killedBy: outcome.killedBy, coveredBy: report[index]!.coveredBy, ...matrix };
      tally.settle(index, settled, resultOf(settled, { durationMs: outcome.durationMs }));
    },
  });
  // Over the time budget: the jobs never started, or stopped between shards.
  for (const { index, entry } of unsettled) {
    notRun.budget++;
    tally.skip(index, entry.mutant, report[index]!.coveredBy);
  }
  if (notRun.budget > 0) log(`time budget of ${timeBudget}s exhausted: ${notRun.budget} mutants not run`);
  return { executed, timeoutRetries: retries.timeout, runtimeErrorRetries: retries.runtimeError };
}

function defaultConcurrency(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

/**
 * A run must make progress (a test starting or finishing) at least this often: the
 * slowest selected test, 3x, plus room for loading the test file's modules. A
 * mutant stuck in a loop is cut here instead of after the sum of all its tests.
 */
function stallBudget(tests: readonly string[], durations: ReadonlyMap<string, number>): number {
  let slowest = 0;
  for (const t of tests) slowest = Math.max(slowest, durations.get(t) ?? 0);
  return Math.round(slowest * 3) + 10_000;
}
