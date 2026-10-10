import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type Report, runMutation } from '../src/run.ts';

const fixture = fileURLToPath(new URL('./fixtures/multi', import.meta.url));
const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));

const statuses = (report: Report) => Object.fromEntries(report.entries.map((e) => [e.mutant.key, e.status]));
const skipped = (report: Report) =>
  report.entries
    .filter((e) => e.source === 'skipped')
    .map((e) => e.mutant.key)
    .sort();
const runKeys = (report: Report) =>
  report.entries
    .filter((e) => e.source === 'run')
    .map((e) => e.mutant.key)
    .sort();

describe('large-run controls', { timeout: 120_000 }, () => {
  let root: string;
  let cold: Report;
  beforeEach(async () => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `sampling-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    cold = await runMutation({ root, concurrency: 1, snapshotPath: join(root, '.mutator/cold.json') });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('--mutants-per-line runs at most n mutants per line; the rest are pending and run later', async () => {
    const sampled = await runMutation({ root, concurrency: 1, mutantsPerLine: 1 });
    const perLine = new Map<string, number>();
    for (const e of sampled.entries) {
      if (e.status === 'Ignored' || e.source === 'skipped') continue;
      const line = `${e.mutant.file}:${e.mutant.location.start.line}`;
      perLine.set(line, (perLine.get(line) ?? 0) + 1);
    }
    expect(Math.max(...perLine.values())).toBe(1);
    expect(sampled.notRun).toEqual({ sampled: skipped(sampled).length, budget: 0 });
    expect(sampled.notRun.sampled).toBeGreaterThan(0);
    expect(sampled.entries.filter((e) => e.source === 'skipped').every((e) => e.status === 'Pending')).toBe(true);
    // Sampled verdicts match a full run.
    for (const e of sampled.entries) if (e.source === 'run') expect(e.status).toBe(statuses(cold)[e.mutant.key]);

    // Switching sampling off runs exactly the mutants left pending; results equal a cold run.
    const full = await runMutation({ root, concurrency: 1 });
    expect(runKeys(full)).toEqual(skipped(sampled));
    expect(full.notRun).toEqual({ sampled: 0, budget: 0 });
    expect(statuses(full)).toEqual(statuses(cold));

    // Back on: everything is cached.
    const again = await runMutation({ root, concurrency: 1, mutantsPerLine: 1 });
    expect(again.executed).toBe(0);
    expect(statuses(again)).toEqual(statuses(cold));
  });

  test('the selection does not depend on the cache', async () => {
    const first = await runMutation({ root, concurrency: 1, mutantsPerLine: 1, snapshotPath: join(root, '.mutator/a.json') });
    const second = await runMutation({ root, concurrency: 1, mutantsPerLine: 1, snapshotPath: join(root, '.mutator/a.json') });
    expect(second.executed).toBe(0);
    expect(skipped(second)).toEqual(skipped(first));
  });

  test('--time-budget 0 starts no mutant; the next run executes them', async () => {
    const none = await runMutation({ root, concurrency: 1, timeBudget: 0 });
    expect(none.executed).toBe(0);
    const pending = skipped(none);
    expect(pending.length).toBeGreaterThan(0);
    expect(none.notRun).toEqual({ sampled: 0, budget: pending.length });

    const full = await runMutation({ root, concurrency: 1 });
    expect(runKeys(full)).toEqual(pending);
    expect(statuses(full)).toEqual(statuses(cold));
  });

  test('a generous budget runs everything', async () => {
    const report = await runMutation({ root, concurrency: 1, timeBudget: 3600, snapshotPath: join(root, '.mutator/b.json') });
    expect(report.notRun).toEqual({ sampled: 0, budget: 0 });
    expect(statuses(report)).toEqual(statuses(cold));
  });
});
