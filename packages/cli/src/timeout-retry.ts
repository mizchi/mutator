// Timeouts are derived from the dry run's durations. A machine that is busier during the
// mutant runs (CI neighbours, parallel jobs) can push a correct but slow run past them, so a
// run that ran out of time is re-run once with a longer budget before it counts as a Timeout.
// A run stopped by the hit limit has proved a loop and is not re-run: real loops stay cheap.
// A RuntimeError (an error outside any test) is re-run once too: an error a flaky test file
// raised under load would otherwise count as a detection of whatever mutant was running.
import type { MutantRunResult, MutantStatus, RunMutantOptions } from '@mizchi/mutator-core';

/** The retry's budget (total and stall) relative to the first run's. */
export const RETRY_FACTOR = 3;

export async function runWithTimeoutRetry(
  run: (options: RunMutantOptions) => Promise<MutantRunResult>,
  options: RunMutantOptions,
): Promise<{ outcome: MutantRunResult; retried: 'timeout' | 'runtimeError' | false }> {
  const first = await run(options);
  if (first.status === 'RuntimeError') {
    const second = await run(options);
    return { outcome: { ...second, durationMs: first.durationMs + second.durationMs }, retried: 'runtimeError' };
  }
  if (first.status !== 'Timeout' || first.timeoutCause === 'hitLimit') return { outcome: first, retried: false };
  const second = await run({
    ...options,
    timeoutMs: options.timeoutMs * RETRY_FACTOR,
    ...(options.stallMs !== undefined ? { stallMs: options.stallMs * RETRY_FACTOR } : {}),
  });
  return { outcome: { ...second, durationMs: first.durationMs + second.durationMs }, retried: 'timeout' };
}

/** Runs re-run once, and how many of them gave the same verdict again (`confirmed`). */
export interface TimeoutRetries {
  retried: number;
  confirmed: number;
}

/** The re-runs of a mutation run, by cause. */
export class RetryCounts {
  readonly timeout: TimeoutRetries = { retried: 0, confirmed: 0 };
  readonly runtimeError: TimeoutRetries = { retried: 0, confirmed: 0 };

  /** Counts a run's re-run (if any); returns what to log about it. */
  count(retried: 'timeout' | 'runtimeError' | false, status: MutantStatus): string | undefined {
    if (retried === 'timeout') {
      this.timeout.retried++;
      if (status === 'Timeout') this.timeout.confirmed++;
      return `timed out, re-ran with ${RETRY_FACTOR}x the budget`;
    }
    if (retried === 'runtimeError') {
      this.runtimeError.retried++;
      if (status === 'RuntimeError') this.runtimeError.confirmed++;
      return 'runtime error, re-ran to confirm it';
    }
    return undefined;
  }
}
