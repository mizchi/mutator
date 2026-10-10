import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MutantResult, RunSnapshot } from '@mizchi/mutator-core';
import { describe, expect, test } from 'vitest';
import { readSnapshot, writeSnapshot } from '../src/snapshot.ts';

const root = '/project';
const tests = Array.from({ length: 200 }, (_, i) => ({ id: `test/some/long/path/file-${i % 20}.test.ts#describe block > case number ${i}`, fingerprint: `fp${i}`, durationMs: i }));
const results: MutantResult[] = Array.from({ length: 2000 }, (_, i) => ({
  key: `k${i}`,
  file: `${root}/src/module-${i % 30}.ts`,
  scopeId: `Scope${i % 50}.method`,
  scopeHash: `h${i % 50}`,
  status: i % 3 === 0 ? 'Killed' : i % 3 === 1 ? 'Survived' : 'NoCoverage',
  killedBy: i % 3 === 0 ? [tests[i % 200]!.id] : [],
  coveredBy: i % 3 === 2 ? [] : tests.slice(i % 150, (i % 150) + 40).map((t) => t.id),
  ...(i % 2 ? { durationMs: i } : {}),
}));
const snapshot: RunSnapshot & { extra: { nested: string[] } } = { toolVersion: 'v', envHash: 'e', tests, results, extra: { nested: ['kept as is'] } };

describe('snapshot format', () => {
  test('round-trips exactly (paths relative on disk, absolute in memory)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'snap-')), 'snapshot.json');
    writeSnapshot(path, snapshot, root);
    expect(readSnapshot(path, root)).toEqual(snapshot);
  });

  test('stores repeated test ids, files and scopes once', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'snap-')), 'snapshot.json');
    writeSnapshot(path, snapshot, root);
    const naive = JSON.stringify(snapshot).length;
    expect(statSync(path).size).toBeLessThan(naive / 5);
  });

  test('reads the previous (uncompacted) format', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'snap-')), 'snapshot.json');
    const legacy = { ...snapshot, results: snapshot.results.map((r) => ({ ...r, file: r.file.slice(root.length + 1) })) };
    writeFileSync(path, JSON.stringify(legacy));
    expect(readSnapshot(path, root)).toEqual(snapshot);
  });
});
