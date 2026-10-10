// Splits long mutant runs into per-test-file shards so idle sessions can share them.
// A mutant that loads with a widely imported module (a static mutant) must run every
// test file that imported it; on one single-worker session that is the slowest job of a run.
import type { MutantRunResult } from '@mizchi/mutator-core';

const fileOf = (test: string) => test.slice(0, test.indexOf('#'));

/**
 * Tests grouped by test file (in order of first appearance, so likely killers stay first)
 * and packed into shards of about `targetMs`. A job cheaper than that stays whole.
 */
export function splitByFile(tests: readonly string[], durations: ReadonlyMap<string, number>, targetMs: number): string[][] {
  const cost = (ts: readonly string[]) => ts.reduce((sum, t) => sum + (durations.get(t) ?? 0), 0);
  if (cost(tests) <= targetMs) return [[...tests]];
  const byFile = new Map<string, string[]>();
  for (const t of tests) byFile.set(fileOf(t), [...(byFile.get(fileOf(t)) ?? []), t]);
  const shards: string[][] = [];
  let current: string[] = [];
  for (const group of byFile.values()) {
    if (current.length > 0 && cost(current) + cost(group) > targetMs) {
      shards.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) shards.push(current);
  return shards;
}

export interface ShardedJob {
  shards: readonly (readonly string[])[];
}

/**
 * Runs jobs on `workers` concurrent sessions. Each job's first shard is started before
 * any job gets a second one; after that, idle workers take the remaining shards of
 * started jobs. A Killed / Timeout / RuntimeError shard settles its job (its other
 * shards are dropped, results still in flight are ignored); a job survives when all
 * its shards survive. Once `shouldStop` is true no new job starts, but started jobs finish.
 * Returns the jobs that never started.
 */
export async function runSharded<J extends ShardedJob>(input: {
  workers: number;
  jobs: readonly J[];
  run: (worker: number, job: J, shard: readonly string[]) => Promise<MutantRunResult>;
  onDone: (job: J, outcome: MutantRunResult) => void;
  shouldStop?: () => boolean;
}): Promise<J[]> {
  const state = input.jobs.map((job) => ({ job, next: 0, running: 0, durationMs: 0, settled: false }));
  let unstarted = 0;
  const take = () => {
    if (unstarted < state.length && !input.shouldStop?.()) return state[unstarted++]!;
    return state.find((s) => s.next > 0 && !s.settled && s.next < s.job.shards.length);
  };
  const settle = (s: (typeof state)[number], outcome: MutantRunResult) => {
    s.settled = true;
    input.onDone(s.job, { ...outcome, durationMs: s.durationMs });
  };
  await Promise.all(
    Array.from({ length: input.workers }, async (_, worker) => {
      for (let s = take(); s; s = take()) {
        const shard = s.job.shards[s.next++]!;
        s.running++;
        const outcome = await input.run(worker, s.job, shard);
        s.running--;
        if (s.settled) continue;
        s.durationMs += outcome.durationMs;
        if (outcome.status !== 'Survived') settle(s, outcome);
        else if (s.next >= s.job.shards.length && s.running === 0) settle(s, outcome);
      }
    }),
  );
  return state.slice(unstarted).map((s) => s.job);
}
