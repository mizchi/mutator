import { type MutantRunResult, type PlanEntry, type Session, emptyDryRun, instrument } from '@mizchi/mutator-core';
import { afterEach, expect, test, vi } from 'vitest';
import { type ExecuteContext, executeJobs } from '../src/execute.ts';
import * as runners from '../src/runner.ts';
import { classifyPlan } from '../src/tally.ts';

afterEach(() => vi.useRealTimers());

function execution(run: Session['runMutant'], count = 1) {
  const mutant = instrument('/p/src/math.ts', 'export const twice = (n: number) => n * 2;').mutants.find((m) => m.original === 'n * 2')!;
  const entry: PlanEntry = { kind: 'run', mutant, tests: ['test/a.ts#case'], isStatic: false, timeoutMs: 60_000 };
  const entries = Array.from({ length: count }, (_, index) => ({ ...entry, mutant: { ...mutant, key: `${mutant.key}-${index}` } }));
  const coverage = new Map(entries.map((e) => [e.mutant.key, e.tests]));
  const { tally, jobs } = classifyPlan(entries, coverage, undefined, undefined);
  const session: Session = {
    mutants: () => [], testFiles: async () => [], configFiles: () => [],
    dryRun: async () => emptyDryRun(), useTestIndex: () => {}, close: async () => {}, runMutant: run,
  };
  const messages: string[] = [];
  const ctx: ExecuteContext = {
    root: '/p', log: (message) => messages.push(message), runner: 'vitest',
    sessionOptions: { root: '/p', targets: new Set(), pluginModules: [], hasPluginObjects: false },
    session, sessions: [session], merged: { ...emptyDryRun(), coverage, spawns: new Map(), reads: new Map(), env: new Map(), tests: [{ id: entry.tests[0]!, fingerprint: 'f', durationMs: 20_000 }] },
    started: performance.now(), timeBudget: undefined, concurrency: 1, killMatrix: false,
    fileOverheadMs: 100, previousDurations: new Map(),
  };
  return { tally, jobs, ctx, messages };
}

test('a long-running mutant emits heartbeat ETA and stops the timer when finished', async () => {
  vi.useFakeTimers();
  let finish!: (result: MutantRunResult) => void;
  const work = execution(() => new Promise((resolve) => { finish = resolve; }));
  const running = executeJobs(work.jobs, work.tally, work.ctx);
  expect(work.messages[0]).toContain('estimated mutant execution:');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(work.messages.some((message) => /progress: 0\/1, elapsed .*ETA ~/.test(message))).toBe(true);
  finish({ status: 'Killed', killedBy: ['test/a.ts#case'], durationMs: 15_000 });
  expect((await running).executed).toBe(1);
  const count = work.messages.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(work.messages).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
});

test('an execution failure also clears the heartbeat', async () => {
  vi.useFakeTimers();
  const work = execution(async () => { throw new Error('runner failed'); });
  await expect(executeJobs(work.jobs, work.tally, work.ctx)).rejects.toThrow('runner failed');
  const count = work.messages.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(work.messages).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
});

test('completed mutant timings update the ETA on progress lines', async () => {
  vi.useFakeTimers();
  let finish!: (result: MutantRunResult) => void;
  let calls = 0;
  const work = execution(async () => {
    if (++calls === 1) return { status: 'Survived', killedBy: [], durationMs: 40_000 };
    return new Promise((resolve) => { finish = resolve; });
  }, 2);
  const running = executeJobs(work.jobs, work.tally, work.ctx);
  await vi.advanceTimersByTimeAsync(0);
  expect(work.messages.some((message) => /\[1\/2\].*ETA ~40s/.test(message))).toBe(true);
  finish({ status: 'Survived', killedBy: [], durationMs: 1000 });
  expect((await running).executed).toBe(2);
});

test('interactive long runs show progress from zero and close the bar on error', async () => {
  const work = execution(async () => { throw new Error('stopped'); });
  const onProgress = vi.fn();
  await expect(executeJobs(work.jobs, work.tally, { ...work.ctx, onProgress })).rejects.toThrow('stopped');
  expect(onProgress.mock.calls[0]?.[0]).toMatchObject({ completed: 0, total: 1 });
  expect(onProgress).toHaveBeenLastCalledWith(undefined);
});

test('the bar counts restored verdicts and a budget stop leaves its actual count', async () => {
  const work = execution(async () => ({ status: 'Survived', killedBy: [], durationMs: 1 }));
  const onProgress = vi.fn();
  await executeJobs(work.jobs, work.tally, { ...work.ctx, resumed: 3, timeBudget: 0, onProgress });
  expect(onProgress.mock.calls).toEqual([[expect.objectContaining({ completed: 3, total: 4 })], [undefined]]);
  expect(work.tally.notRun.budget).toBe(1);
});

test.each([
  { budget: 5, concurrency: 2, expected: [3, 2] },
  { budget: 2, concurrency: 4, expected: [1, 1] },
])('shares $budget workers across at most $concurrency sessions', async ({ budget, concurrency, expected }) => {
  const work = execution(async () => ({ status: 'Survived', killedBy: [], durationMs: 1 }), 4);
  work.ctx.sessionOptions.maxWorkers = budget;
  const create = vi.spyOn(runners, 'createRunnerSession').mockResolvedValue(work.ctx.session);
  try {
    const report = await executeJobs(work.jobs, work.tally, { ...work.ctx, concurrency });
    expect(create.mock.calls.map(([, options]) => options.maxWorkers)).toEqual(expected);
    expect(report.executed).toBe(4);
  } finally {
    create.mockRestore();
  }
});
