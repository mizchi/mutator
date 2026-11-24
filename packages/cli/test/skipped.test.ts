import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { formatSkipped, listSkipped } from '../src/skipped.ts';

describe('mutator skipped', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mutator-skipped-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'export function f(a: number) {\n  g(a + 1);\n}\nexport const p = (a: number): boolean => a > 1;\ndeclare function g(n: number): void;\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('lists the candidates skip rules removed, with project-relative files and justifying keys', async () => {
    const { skipped, mutants } = await listSkipped({ root, runner: 'vitest' });
    const rows = skipped.map((s) => `${s.file}:${s.location.start.line} ${s.rule} ${s.category}`);
    expect(rows).toEqual(expect.arrayContaining(['src/a.ts:2 redundant-call subsumed', 'src/a.ts:4 same-edit duplicate']));
    for (const s of skipped) expect(mutants.some((m) => m.key === s.by)).toBe(true);
    // 1-based columns, like mutation.json: `  g(a + 1);` starts at column 3.
    expect(skipped.find((s) => s.rule === 'redundant-call')?.location.start).toEqual({ line: 2, column: 3 });
    for (const s of skipped) expect(s.key).toMatch(/^[0-9a-z]+$/);
  });

  test('text format: one line per skip and a count by rule', async () => {
    const { skipped } = await listSkipped({ root, runner: 'vitest' });
    const text = formatSkipped(skipped);
    expect(text).toContain('src/a.ts:2 CallExpression g(a + 1); -> ;  redundant-call (subsumed, heuristic)');
    expect(text.trimEnd().split('\n').at(-1)).toMatch(/^skipped: 3 \(same-edit 2, redundant-call 1\)$/);
  });

  test('text format with nothing skipped', () => {
    expect(formatSkipped([])).toBe('skipped: 0\n');
  });
});

describe('--skip-subsumed', { timeout: 120_000 }, () => {
  test('a run drops coarse mutants with finer ones inside; every other verdict is the same', async () => {
    // Under the repository, so the fixture resolves vitest.
    const root = mkdtempSync(join(import.meta.dirname, '../../../.tmp/solitary-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'test'));
      writeFileSync(join(root, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n");
      writeFileSync(join(root, 'src/a.ts'), 'export function f(a: number): number {\n  if (a > 1) {\n    return a + 1;\n  }\n  return 0;\n}\n');
      writeFileSync(join(root, 'test/a.test.ts'), "import { expect, test } from 'vitest';\nimport { f } from '../src/a.ts';\ntest('f', () => { expect(f(2)).toBe(3); expect(f(0)).toBe(0); });\n");
      const { runMutation } = await import('../src/run.ts');
      const off = await runMutation({ root, concurrency: 1, typecheck: false, snapshotPath: join(root, '.mutator/off.json') });
      const on = await runMutation({ root, concurrency: 1, typecheck: false, skipSubsumed: true, snapshotPath: join(root, '.mutator/on.json') });
      const verdicts = (r: typeof on) => new Map(r.entries.map((e) => [e.mutant.key, e.status]));
      const before = verdicts(off);
      const after = verdicts(on);
      const { skipped } = await listSkipped({ root, runner: 'vitest', skipSubsumed: true });
      const solitary = skipped.filter((s) => s.rule === 'solitary');
      expect(solitary.map((s) => s.mutator)).toContain('BlockStatement');
      expect(after.size).toBe(before.size - solitary.length);
      for (const [key, status] of after) expect(before.get(key)).toBe(status);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
