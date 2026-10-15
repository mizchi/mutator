import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { formatAgentReport } from '../src/agent-report.ts';
import { formatMutationTestingJson } from '../src/mte-report.ts';
import { formatSummary } from '../src/report.ts';
import { runMutation } from '../src/run.ts';

const fixture = fileURLToPath(new URL('./fixtures/matrix', import.meta.url));
const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));

const THOROUGH = 'test/clamp.test.ts#thorough';
const BELOW = 'test/clamp.test.ts#below';
const AGAIN = 'test/again.test.ts#below again';
const SMOKE = 'test/clamp.test.ts#smoke';

describe('--kill-matrix', { timeout: 120_000 }, () => {
  let root: string;
  beforeEach(() => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `matrix-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('records every killing test and finds tests that detect nothing or are subsumed', async () => {
    // A normal run first: its kills stop at the first failing test.
    const normal = await runMutation({ root, concurrency: 1 });
    expect(normal.killMatrix).toBeUndefined();
    const killedNormally = normal.entries.filter((e) => e.status === 'Killed');
    expect(killedNormally.length).toBeGreaterThan(0);
    expect(killedNormally.every((e) => e.matrix === undefined)).toBe(true);

    // The matrix run re-runs those kills (they are not full matrices) and reuses the survivors.
    const matrix = await runMutation({ root, concurrency: 2, killMatrix: true });
    expect(matrix.executed).toBe(killedNormally.length);
    const lowerBound = matrix.entries.find((e) => e.mutant.original === 'x < lo' && e.mutant.replacement === 'false')!;
    expect(lowerBound).toMatchObject({ status: 'Killed', matrix: true });
    expect([...lowerBound.killedBy].sort()).toEqual([AGAIN, BELOW, THOROUGH]);

    const analysis = matrix.killMatrix!;
    expect(analysis.mutants.full).toBe(matrix.entries.filter((e) => e.status === 'Killed' || e.status === 'Survived').length);
    expect(analysis.noKills).toEqual([SMOKE]);
    expect(analysis.subsumed).toEqual([
      { test: AGAIN, kills: expect.any(Number), by: [THOROUGH] },
      { test: BELOW, kills: expect.any(Number), by: [THOROUGH] },
    ]);
    expect(analysis.duplicates).toEqual([{ tests: [AGAIN, BELOW], kills: expect.any(Number) }]);

    const text = formatSummary(matrix, root);
    expect(text).toContain('kill matrix');
    expect(text).toContain(SMOKE);
    expect(text).toContain(`${BELOW}  subsumed by ${THOROUGH}`);
    expect(formatAgentReport(matrix, root).killMatrix).toEqual(analysis);
    expect(formatMutationTestingJson(matrix, root).killMatrix).toEqual(analysis);

    // Full matrices are reused by the next matrix run, and their verdicts by a normal run.
    const again = await runMutation({ root, concurrency: 1, killMatrix: true });
    expect(again.executed).toBe(0);
    expect(again.killMatrix).toEqual(analysis);
    const after = await runMutation({ root, concurrency: 1 });
    expect(after.executed).toBe(0);
  });

  test('works with --mutants-per-line: mutants not run are excluded and counted', async () => {
    const report = await runMutation({ root, concurrency: 1, killMatrix: true, mutantsPerLine: 1 });
    const pending = report.entries.filter((e) => e.status === 'Pending').length;
    expect(pending).toBeGreaterThan(0);
    expect(report.killMatrix!.mutants.incomplete).toBe(pending);
  });
});
