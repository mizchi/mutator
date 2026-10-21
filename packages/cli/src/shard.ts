// Splits long mutant runs into per-test-file shards so idle sessions can share them.
// A mutant that loads with a widely imported module (a static mutant) must run every
// test file that imported it; on one single-worker session that is the slowest job of a run.
import { type MutantRunResult, testFileOf } from '@mizchi/mutator-core';

/**
 * Tests grouped by test file (in order of first appearance, so likely killers stay first)
 * and packed into shards of about `targetMs`. A job cheaper than that stays whole.
 */
export function splitByFile(tests: readonly string[], durations: ReadonlyMap<string, number>, targetMs: number): string[][] {
  const cost = (ts: readonly string[]) => ts.reduce((sum, t) => sum + (durations.get(t) ?? 0), 0);
  if (cost(tests) <= targetMs) return [[...tests]];
  const byFile = new Map<string, string[]>();
  for (const t of tests) byFile.set(testFileOf(t), [...(byFile.get(testFileOf(t)) ?? []), t]);
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
 * its shards survive. Once `shouldStop` is true no shard starts, not even one of a started
 * job: only the shards in flight finish, so a deadline is overrun by one shard at most.
 * With `allShards` (kill matrix) only a Timeout settles a job early: every other shard runs,
 * and the job's failing tests are those of all its shards.
 * Returns the jobs left unsettled: never started, or stopped between shards.
 */
export async function runSharded<J extends ShardedJob>(input: {
  workers: number;
  jobs: readonly J[];
  run: (worker: number, job: J, shard: readonly string[]) => Promise<MutantRunResult>;
  onDone: (job: J, outcome: MutantRunResult) => void;
  shouldStop?: () => boolean;
  allShards?: boolean;
}): Promise<J[]> {
  const state = input.jobs.map((job) => ({ job, next: 0, running: 0, durationMs: 0, settled: false, outcomes: [] as MutantRunResult[] }));
  let unstarted = 0;
  const take = () => {
    if (input.shouldStop?.()) return undefined;
    if (unstarted < state.length) return state[unstarted++]!;
    return state.find((s) => s.next > 0 && !s.settled && s.next < s.job.shards.length);
  };
  const settle = (s: (typeof state)[number], outcome: MutantRunResult) => {
    s.settled = true;
    input.onDone(s.job, { ...outcome, durationMs: s.durationMs });
  };
  await Promise.all(
    Array.from({ length: input.workers }, async (_, worker) => {
      for (let s = take(); s; s = take()) {
        const index = s.next++;
        const shard = s.job.shards[index]!;
        s.running++;
        const outcome = await input.run(worker, s.job, shard);
        s.running--;
        if (s.settled) continue;
        s.durationMs += outcome.durationMs;
        // Kept in shard order: killers stay in the planned order.
        s.outcomes[index] = outcome;
        const decisive = input.allShards ? outcome.status === 'Timeout' : outcome.status !== 'Survived';
        if (decisive) settle(s, outcome);
        else if (s.next >= s.job.shards.length && s.running === 0) settle(s, input.allShards ? combine(s.outcomes) : outcome);
      }
    }),
  );
  return state.filter((s) => !s.settled).map((s) => s.job);
}

/** Shards of one job, none timed out: the failing tests of all of them, under the strongest verdict. */
function combine(outcomes: readonly MutantRunResult[]): MutantRunResult {
  const status = outcomes.some((o) => o.status === 'Killed') ? 'Killed' : outcomes.some((o) => o.status === 'RuntimeError') ? 'RuntimeError' : 'Survived';
  return { status, killedBy: [...new Set(outcomes.flatMap((o) => o.killedBy))], durationMs: 0 };
}
