import { describe, expect, test } from 'vitest';
import { runSharded, splitByFile } from '../src/shard.ts';

const d = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe('splitByFile', () => {
  test('a cheap job stays whole', () => {
    expect(splitByFile(['a#1', 'b#1', 'a#2'], d({ 'a#1': 100, 'b#1': 100, 'a#2': 100 }), 10_000)).toEqual([['a#1', 'b#1', 'a#2']]);
  });

  test('an expensive job is split by test file, keeping the test order and packing files up to the target', () => {
    const durations = d({ 'a#1': 6000, 'b#1': 3000, 'c#1': 3000, 'a#2': 1000, 'd#1': 20_000 });
    expect(splitByFile(['a#1', 'b#1', 'c#1', 'a#2', 'd#1'], durations, 10_000)).toEqual([['a#1', 'a#2', 'b#1'], ['c#1'], ['d#1']]);
  });
});

type Outcome = { status: 'Killed' | 'Survived' | 'Timeout' | 'RuntimeError'; killedBy: string[]; durationMs: number };
const tick = () => new Promise((r) => setTimeout(r, 1));

describe('runSharded', () => {
  test('starts every job before helping with the remaining shards of started ones', async () => {
    const order: string[] = [];
    const jobs = [{ id: 'j1', shards: [['a'], ['b'], ['c']] }, { id: 'j2', shards: [['x']] }];
    const done = new Map<string, Outcome>();
    await runSharded({
      workers: 2,
      jobs,
      run: async (_worker, job, shard) => {
        order.push(`${job.id}:${shard.join()}`);
        await tick();
        return { status: 'Survived', killedBy: [], durationMs: 1 };
      },
      onDone: (job, outcome) => done.set(job.id, outcome),
    });
    expect(order.slice(0, 2).sort()).toEqual(['j1:a', 'j2:x']);
    expect(order.sort()).toEqual(['j1:a', 'j1:b', 'j1:c', 'j2:x']);
    expect(done.get('j1')).toEqual({ status: 'Survived', killedBy: [], durationMs: 3 });
  });

  test('a killing shard settles the job and its remaining shards are not run', async () => {
    const ran: string[] = [];
    const done = new Map<string, Outcome>();
    await runSharded({
      workers: 1,
      jobs: [{ id: 'j', shards: [['a'], ['b'], ['c']] }],
      run: async (_w, _job, shard) => {
        ran.push(shard.join());
        return shard[0] === 'b' ? { status: 'Killed', killedBy: ['b'], durationMs: 2 } : { status: 'Survived', killedBy: [], durationMs: 1 };
      },
      onDone: (job, outcome) => done.set(job.id, outcome),
    });
    expect(ran).toEqual(['a', 'b']);
    expect(done.get('j')).toEqual({ status: 'Killed', killedBy: ['b'], durationMs: 3 });
  });

  test('results of shards still in flight after the job settled are ignored; each job settles once', async () => {
    const settled: string[] = [];
    await runSharded({
      workers: 2,
      jobs: [{ id: 'j', shards: [['slow'], ['kill']] }],
      run: async (_w, _job, shard) => {
        if (shard[0] === 'slow') {
          await tick();
          await tick();
          return { status: 'Timeout', killedBy: [], durationMs: 9 };
        }
        return { status: 'Killed', killedBy: ['kill'], durationMs: 1 };
      },
      onDone: (job, outcome) => settled.push(`${job.id}:${outcome.status}`),
    });
    expect(settled).toEqual(['j:Killed']);
  });

  test('stops taking work once `shouldStop` says so', async () => {
    let calls = 0;
    const done: string[] = [];
    await runSharded({
      workers: 1,
      jobs: [{ id: 'j1', shards: [['a']] }, { id: 'j2', shards: [['b']] }],
      run: async () => {
        calls++;
        return { status: 'Survived', killedBy: [], durationMs: 1 };
      },
      onDone: (job) => done.push(job.id),
      shouldStop: () => calls >= 1,
    });
    expect(done).toEqual(['j1']);
  });
});
