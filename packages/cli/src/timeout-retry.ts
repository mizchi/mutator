// Timeouts are derived from the dry run's durations. A machine that is busier during the
// mutant runs (CI neighbours, parallel jobs) can push a correct but slow run past them, so a
// run that ran out of time is re-run once with a longer budget before it counts as a Timeout.
// A run stopped by the hit limit has proved a loop and is not re-run: real loops stay cheap.
// A RuntimeError (an error outside any test) is re-run once too: an error a flaky test file
// raised under load would otherwise count as a detection of whatever mutant was running.
import type { MutantRunResult, RunMutantOptions } from '@mizchi/mutator-core';

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
