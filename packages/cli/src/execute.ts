// Running the mutants that need a run, over parallel runner sessions and within the time budget.
import { availableParallelism } from 'node:os';
import { type Session, estimatedCost, orderByCost, relativePath as relative } from '@mizchi/mutator-core';
import type { Checkpoint } from './checkpoint.ts';
import type { MutationProgress } from './progress.ts';
import type { MergedDryRun } from './coverage-cache.ts';
import { oneLine } from './report.ts';
import type { ReportEntry } from './run.ts';
import { type Runner, type RunnerSessionOptions, createRunnerSession } from './runner.ts';
import { runSharded, splitByFile } from './shard.ts';
import { type Job, type Tally, resultOf } from './tally.ts';
import { RetryCounts, type TimeoutRetries, runWithTimeoutRetry } from './timeout-retry.ts';
import { type RunEstimate, estimateWork, formatDuration, remainingMs } from './estimate.ts';

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
  fileOverheadMs: number;
  resumed?: number;
  checkpoint?: Pick<Checkpoint, 'save'>;
  onProgress?: (state: MutationProgress | undefined) => void;
  previousDurations: ReadonlyMap<string, number>;
}

/**
 * Run the jobs over parallel sessions; those over the time budget are skipped. Returns how many
 * ran, and how many runs timed out and were re-run with a longer budget (`confirmed`: timed out again).
 */
export async function executeJobs(jobs: Job[], tally: Tally, ctx: ExecuteContext): Promise<{ executed: number; timeoutRetries: TimeoutRetries; runtimeErrorRetries: TimeoutRetries; estimate: RunEstimate }> {
  const { root, log, merged, timeBudget } = ctx;
  const { report, notRun } = tally;
  const testDurations = new Map(merged.tests.map((t) => [t.id, t.durationMs]));
  // Under a budget, cheapest first: the budget then settles as many mutants as possible.
  if (timeBudget !== undefined) jobs.splice(0, jobs.length, ...orderByCost(jobs, (j) => estimatedCost(j.entry.tests, testDurations), (j) => j.entry.mutant.key));
  // Long runs (typically static mutants, which run every test file that loaded them) are
  // split by test file so idle sessions can take part of them.
  const sharded = jobs.map((job) => ({ ...job, shards: splitByFile(job.entry.tests, testDurations, SHARD_TARGET_MS) }));
  const shardCount = sharded.reduce((n, j) => n + j.shards.length, 0);
  const budget = ctx.sessionOptions.maxWorkers;
  const concurrency = Math.max(1, Math.min(ctx.concurrency ?? defaultConcurrency(), budget ?? Infinity, shardCount));
  const prediction = estimateWork(jobs.map(({ entry }) => ({ key: entry.mutant.key, tests: entry.tests })), {
    durations: testDurations, workers: concurrency, fileOverheadMs: ctx.fileOverheadMs, previous: ctx.previousDurations,
  });
  const { estimate } = prediction;
  if (jobs.length > 0) log(`estimated mutant execution: ~${formatDuration(estimate.durationMs)} (${concurrency} sessions; ${estimate.historySamples}/${jobs.length} historical timings, remaining costs from dry run)`);
  // With an explicit budget, share all slots, giving one extra to each of the first
  // sessions until the remainder is used. A lone session reuses the baseline's budget.
  const workers = concurrency === 1 ? [ctx.session] : await Promise.all(Array.from({ length: concurrency }, (_, index) => {
    const maxWorkers = budget === undefined ? 1 : Math.floor(budget / concurrency) + Number(index < budget % concurrency);
    return createRunnerSession(ctx.runner, { ...ctx.sessionOptions, maxWorkers });
  }));
  if (concurrency > 1) ctx.sessions.push(...workers);
  for (const s of workers) s.useTestIndex(merged.index);
  const deadline = timeBudget !== undefined ? ctx.started + timeBudget * 1000 : Infinity;
  let executed = 0;
  let observedWorkMs = 0;
  let completedCostMs = 0;
  const resumed = ctx.resumed ?? 0;
  const total = jobs.length + resumed;
  const large = jobs.length > 0 && (total >= 100 || estimate.durationMs >= 10_000);
  if (large && ctx.checkpoint) log('Saving each completed mutant. After interruption, rerun the same command to resume.');
  const interactive = large ? ctx.onProgress : undefined;
  const eta = () => `ETA ~${formatDuration(remainingMs(prediction, completedCostMs, observedWorkMs))}`;
  const update = () => interactive?.({
    completed: resumed + executed,
    total,
    elapsedMs: performance.now() - ctx.started,
    remainingMs: remainingMs(prediction, completedCostMs, observedWorkMs),
  });
  const retries = new RetryCounts();
  update();
  const heartbeatLog = () => log(`progress: ${resumed + executed}/${total}, elapsed ${formatDuration(performance.now() - ctx.started)}, ${eta()}`);
  const heartbeat = large ? setInterval(interactive ? update : heartbeatLog, interactive ? 1000 : 15_000) : undefined;
  heartbeat?.unref();
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
    onDone: (job, outcome) => {
      ctx.checkpoint?.save(job, outcome);
      const { index, entry } = job;
      const { mutant } = entry;
      executed++;
      completedCostMs += prediction.costs.get(mutant.key) ?? 0;
      observedWorkMs += outcome.durationMs;

      const matrix = ctx.killMatrix && outcome.status === 'Killed' ? { matrix: true as const } : {};
      const settled: ReportEntry = { mutant, status: outcome.status, source: 'run', killedBy: outcome.killedBy, coveredBy: report[index]!.coveredBy, ...matrix };
      tally.settle(index, settled, resultOf(settled, { durationMs: outcome.durationMs }));
      if (interactive) update();
      else log(`[${resumed + executed}/${total}] ${outcome.status.padEnd(8)} ${relative(root, mutant.file)}:${mutant.location.start.line} ${oneLine(mutant.original)} -> ${oneLine(mutant.replacement)}${large && executed < jobs.length ? ` (${eta()})` : ''}`);
    },
  }).finally(() => {
    clearInterval(heartbeat);
    interactive?.(undefined);
  });
  // Over the time budget: the jobs never started, or stopped between shards.
  for (const { index, entry } of unsettled) {
    notRun.budget++;
    tally.skip(index, entry.mutant, report[index]!.coveredBy);
  }
  if (notRun.budget > 0) log(`time budget of ${timeBudget}s exhausted: ${notRun.budget} mutants not run`);
  return { executed, timeoutRetries: retries.timeout, runtimeErrorRetries: retries.runtimeError, estimate };
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
