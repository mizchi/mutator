import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MutantRunResult, RunMutantOptions } from '@mizchi/mutator-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { formatSummary } from '../src/report.ts';
import { runMutation } from '../src/run.ts';
import { RETRY_FACTOR, runWithTimeoutRetry } from '../src/timeout-retry.ts';

const result = (status: MutantRunResult['status'], extra: Partial<MutantRunResult> = {}): MutantRunResult => ({ status, killedBy: [], durationMs: 100, ...extra });

describe('runWithTimeoutRetry', () => {
  const recording = (outcomes: MutantRunResult[]) => {
    const calls: RunMutantOptions[] = [];
    const run = async (options: RunMutantOptions) => {
      calls.push(options);
      return outcomes[calls.length - 1]!;
    };
    return { calls, run };
  };

  test('a run that finishes is not retried', async () => {
    const { calls, run } = recording([result('Killed', { killedBy: ['t'] })]);
    const { outcome, retried } = await runWithTimeoutRetry(run, { timeoutMs: 1000, stallMs: 500 });
    expect(outcome.status).toBe('Killed');
    expect(retried).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test('a wall-clock timeout is re-run once with a longer budget; the second verdict counts', async () => {
    const { calls, run } = recording([result('Timeout', { timeoutCause: 'time' }), result('Killed', { killedBy: ['t'], durationMs: 50 })]);
    const { outcome, retried } = await runWithTimeoutRetry(run, { timeoutMs: 1000, stallMs: 500, hitLimit: 10 });
    expect(retried).toBe(true);
    expect(outcome).toMatchObject({ status: 'Killed', killedBy: ['t'], durationMs: 150 });
    expect(calls).toEqual([
      { timeoutMs: 1000, stallMs: 500, hitLimit: 10 },
      { timeoutMs: 1000 * RETRY_FACTOR, stallMs: 500 * RETRY_FACTOR, hitLimit: 10 },
    ]);
  });

  test('a run timing out twice is a Timeout', async () => {
    const { calls, run } = recording([result('Timeout', { timeoutCause: 'time' }), result('Timeout', { timeoutCause: 'time' })]);
    const { outcome, retried } = await runWithTimeoutRetry(run, { timeoutMs: 1000 });
    expect(outcome.status).toBe('Timeout');
    expect(retried).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ timeoutMs: 1000 * RETRY_FACTOR });
  });

  test('a run stopped by the hit limit proved a loop and is not retried', async () => {
    const { calls, run } = recording([result('Timeout', { timeoutCause: 'hitLimit' })]);
    const { outcome, retried } = await runWithTimeoutRetry(run, { timeoutMs: 1000 });
    expect(outcome.status).toBe('Timeout');
    expect(retried).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

const fixture = fileURLToPath(new URL('./fixtures/slow-once', import.meta.url));
const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));

describe('a mutant run slowed down once', { timeout: 120_000 }, () => {
  let root: string;
  beforeEach(() => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `slow-once-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    process.env.MUTATOR_SLOW_ONCE = join(root, 'counter');
  });
  afterEach(() => {
    delete process.env.MUTATOR_SLOW_ONCE;
    delete process.env.MUTATOR_SLOW_ALWAYS;
    rmSync(root, { recursive: true, force: true });
  });

  test('is re-run with a longer budget instead of being reported as a timeout', async () => {
    // Budget: dry-run duration + 2.5 s. The slowed run sleeps 6 s and times out; the
    // retry gets 3x the budget and does not sleep.
    const report = await runMutation({ root, concurrency: 1, timeoutFactor: 1, timeoutMs: 2500, typecheck: false });
    expect(Number(readFileSync(join(root, 'counter'), 'utf8'))).toBeGreaterThanOrEqual(3);
    const add = report.entries.find((e) => e.mutant.original === 'a + b' && e.mutant.replacement === 'a - b')!;
    expect(add.status).toBe('Killed');
    expect(report.entries.filter((e) => e.status === 'Timeout')).toEqual([]);
    expect(report.timeoutRetries).toEqual({ retried: 1, confirmed: 0 });
    expect(formatSummary(report, root)).toContain('timeouts re-run with a longer budget: 1 (0 timed out again)');
  });

  test('a run that times out again is a Timeout, counted as confirmed', async () => {
    process.env.MUTATOR_SLOW_ALWAYS = '1';
    const report = await runMutation({ root, concurrency: 1, timeoutFactor: 1, timeoutMs: 1000, typecheck: false });
    const run = report.entries.filter((e) => e.source === 'run');
    expect(run.length).toBeGreaterThan(0);
    expect(run.every((e) => e.status === 'Timeout')).toBe(true);
    expect(report.timeoutRetries).toEqual({ retried: run.length, confirmed: run.length });
  });
});
