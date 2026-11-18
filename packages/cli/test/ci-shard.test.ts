import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ownsMutant, parseShard } from '../src/ci-shard.ts';
import { runMutation } from '../src/run.ts';
import { snapshotFiles } from '../src/snapshot-store.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('CI shard assignment', () => {
  test('parses one-based INDEX/COUNT and rejects invalid or unsafe integers', () => {
    expect(parseShard('2/4')).toEqual({ index: 2, total: 4 });
    for (const value of ['0/4', '5/4', '1/0', '1.5/4', '1', '1/2/3', '-1/4', '1/Infinity', '1/9007199254740992']) {
      expect(() => parseShard(value), value).toThrow('shard');
    }
  });

  test('every key belongs to exactly one shard, independently of input order', () => {
    const keys = Array.from({ length: 1000 }, (_, i) => `mutant-${i}`);
    const parts = Array.from({ length: 7 }, (_, i) => keys.filter((key) => ownsMutant(key, { index: i + 1, total: 7 })));
    expect(parts.flat().sort()).toEqual([...keys].sort());
    expect(new Set(parts.flat()).size).toBe(keys.length);
    expect(parts.every((part) => part.length > 100)).toBe(true);
    expect([...keys].reverse().filter((key) => ownsMutant(key, { index: 2, total: 7 })).reverse()).toEqual(parts[1]);
  });

  test('snapshots for different shards and counts are separate from a full run', () => {
    const paths = [undefined, { index: 1, total: 2 }, { index: 2, total: 2 }, { index: 1, total: 3 }]
      .map((shard) => snapshotFiles('/project', { root: '/project', ...(shard ? { shard } : {}) }));
    expect(new Set(paths.flat()).size).toBe(paths.flat().length);
  });
});

test('shards partition a full run, retain their own caches, and compose with sampling', { timeout: 120_000 }, async () => {
  const tmp = join(import.meta.dirname, '../../../.tmp');
  mkdirSync(tmp, { recursive: true });
  const root = mkdtempSync(join(tmp, 'ci-shard-'));
  roots.push(root);
  cpSync(join(import.meta.dirname, 'fixtures/multi'), root, { recursive: true });
  const base = { root, concurrency: 1, typecheck: false, weakMutation: false } as const;
  const messages: string[] = [];
  const full = await runMutation({ ...base, log: (message) => messages.push(message) });
  expect(full.estimate?.mutants).toBe(full.executed);
  expect(messages.some((message) => message.startsWith('estimated mutant execution:'))).toBe(true);
  const fullSnapshot = readFileSync(join(root, '.mutator/snapshot.json'), 'utf8');
  const parts = [];
  for (let index = 1; index <= 3; index++) {
    const shard = { index, total: 3 };
    const report = await runMutation({ ...base, shard });
    expect(report.shard).toEqual(shard);
    expect(report.entries.length).toBeGreaterThan(0);
    expect(report.entries.every((e) => ownsMutant(e.mutant.key, shard))).toBe(true);
    expect(report.notRun).toEqual({ sampled: 0, budget: 0 });
    expect(existsSync(snapshotFiles(root, { ...base, shard })[0]!)).toBe(true);
    const warm = await runMutation({ ...base, shard });
    expect(warm.executed).toBe(0);
    expect(warm.dryRunFiles).toEqual([]);
    const accepted = new Map(full.entries.filter((entry) => entry.status === 'Survived').map((entry) => [entry.mutant.key, 'equivalent']));
    const reviewed = await runMutation({ ...base, shard, accepted });
    expect(reviewed.acceptance?.stale ?? []).toEqual([]);
    parts.push(report);
  }
  const statuses = (entries: typeof full.entries) => Object.fromEntries(entries.map((e) => [e.mutant.key, e.status]));
  expect(statuses(parts.flatMap((p) => p.entries))).toEqual(statuses(full.entries));
  expect(parts.reduce((n, p) => n + p.entries.length, 0)).toBe(full.entries.length);
  expect(readFileSync(join(root, '.mutator/snapshot.json'), 'utf8')).toBe(fullSnapshot);

  const total = full.entries.length + 1;
  const empty = Array.from({ length: total }, (_, i) => ({ index: i + 1, total }))
    .find((shard) => full.entries.every((entry) => !ownsMutant(entry.mutant.key, shard)))!;
  const otherKey = full.entries[0]!.mutant.key;
  const emptyReport = await runMutation({ ...base, shard: empty, only: new Set([otherKey]) });
  expect(emptyReport.entries).toEqual([]);
  expect(emptyReport.executed).toBe(0);
  expect(emptyReport.unknownKeys).toBeUndefined();
  expect(emptyReport.noCoverage).toBeUndefined();

  const sampled = await runMutation({ ...base, mutantsPerLine: 1, snapshotPath: join(root, '.mutator/sampled.json') });
  const sampledParts = [];
  for (let index = 1; index <= 3; index++) {
    sampledParts.push(await runMutation({ ...base, mutantsPerLine: 1, shard: { index, total: 3 }, snapshotPath: join(root, `.mutator/sampled-${index}.json`) }));
  }
  expect(statuses(sampledParts.flatMap((p) => p.entries))).toEqual(statuses(sampled.entries));
});
