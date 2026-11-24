import { describe, expect, test } from 'vitest';
import { estimateWork, formatDuration, remainingMs } from '../src/estimate.ts';

const jobs = [
  { key: 'a', tests: ['test/a.ts#1', 'test/a.ts#2'] },
  { key: 'b', tests: ['test/b.ts#1'] },
];
const durations = new Map([['test/a.ts#1', 1000], ['test/a.ts#2', 2000], ['test/b.ts#1', 4000]]);

test('a cold estimate includes one loading overhead per file and accounts for parallel sessions', () => {
  const plan = estimateWork(jobs, { durations, fileOverheadMs: 500, workers: 2 });
  expect(plan.costs.get('a')).toBe(3500);
  expect(plan.costs.get('b')).toBe(4500);
  expect(plan.estimate).toMatchObject({ durationMs: 4000, workers: 2, mutants: 2, historySamples: 0 });
});

test('known mutant timings take precedence, and observed work recalibrates the remaining estimate', () => {
  const plan = estimateWork(jobs, { durations, fileOverheadMs: 500, workers: 1, previous: new Map([['a', 500]]) });
  expect(plan.estimate).toMatchObject({ durationMs: 5000, historySamples: 1 });
  expect(remainingMs(plan, 0, 0)).toBe(5000);
  expect(remainingMs(plan, plan.costs.get('a')!, 1000)).toBe(9000);
  expect(remainingMs(plan, plan.totalCostMs, 2000)).toBe(0);
});

test('empty plans and invalid historical timings never produce NaN or infinite estimates', () => {
  const empty = estimateWork([], { durations: new Map(), fileOverheadMs: 0, workers: 1 });
  expect(empty.estimate.durationMs).toBe(0);
  expect(remainingMs(empty, 0, 0)).toBe(0);
  const plan = estimateWork(jobs, { durations: new Map(), fileOverheadMs: 0, workers: 2, previous: new Map([['a', NaN], ['b', Infinity]]) });
  expect(plan.estimate.durationMs).toBeGreaterThan(0);
  expect(Number.isFinite(remainingMs(plan, plan.costs.get('a')!, 10))).toBe(true);
});

test('durations stay readable for long CI runs', () => {
  expect([0, 100, 1500, 90_000, 7_260_000].map(formatDuration)).toEqual(['0s', '<1s', '2s', '1m 30s', '2h 1m']);
});

describe('remainingMs with jobs settled without a run', () => {
  test('their cost is no longer remaining and does not scale the rest', () => {
    const plan = { totalCostMs: 200, costs: new Map(), estimate: { durationMs: 200, workers: 1, historySamples: 0 } } as unknown as Parameters<typeof remainingMs>[0];
    // One 100 ms job settled by the type check, the other not started yet.
    expect(remainingMs(plan, 0, 0, 100)).toBe(100);
    // One run took twice its prediction; the settled one does not dilute the scale.
    expect(remainingMs({ ...plan, totalCostMs: 300 }, 100, 200, 100)).toBe(200);
  });
});
