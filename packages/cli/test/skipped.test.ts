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
