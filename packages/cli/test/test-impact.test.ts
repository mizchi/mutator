import { describe, expect, test } from 'vitest';
import { instrument, toResult } from '@mizchi/mutator-core';
import { changedTestIds, detectionRegressions, testChangeSelection } from '../src/test-impact.ts';
import type { ReportEntry } from '../src/run.ts';

const root = '/project';
const mutants = instrument(`${root}/src/a.ts`, 'export const double = (n: number) => n * 2;').mutants;
const mutant = mutants[0]!;
const before = toResult(mutant, 'Killed', ['test/a.ts#old'], ['test/a.ts#old']);

describe('test change impact', () => {
  test('includes added, edited and removed tests but leaves unchanged tests alone', () => {
    const testInfo = (id: string, fingerprint = 'same') => ({ id, fingerprint, durationMs: 1 });
    expect(changedTestIds([testInfo('same'), testInfo('edit'), testInfo('removed')], [testInfo('same'), testInfo('edit', 'new'), testInfo('added')])).toEqual(new Set(['added', 'edit', 'removed']));
  });

  test('a new test without reached mutants falls back to its observed imports', () => {
    const reasons = testChangeSelection({ root, mutants, changed: new Set(['test/new.ts#new']), previous: [], coverage: new Map(), deps: new Map([['test/new.ts', ['src/a.ts']]]) });
    expect(reasons.map((r) => r.key)).toEqual(mutants.map((m) => m.key));
    expect(reasons.every((r) => r.tests[0] === 'test/new.ts#new')).toBe(true);
  });

  test('coverage of a removed mutant does not suppress the import fallback', () => {
    const reasons = testChangeSelection({ root, mutants, changed: new Set(['test/a.ts#old']), previous: [{ ...before, key: 'no-longer-exists' }], coverage: new Map(), deps: new Map([['test/a.ts', ['src/a.ts']]]) });
    expect(reasons.map((r) => r.key)).toEqual(mutants.map((m) => m.key).sort((a, b) => a.localeCompare(b)));
  });

  test('a deleted test keeps its former coverage in the selected work', () => {
    const reasons = testChangeSelection({ root, mutants, changed: new Set(['test/a.ts#old']), previous: [before], coverage: new Map(), deps: new Map() });
    expect(reasons).toEqual([{ key: mutant.key, reason: 'changedTest', tests: ['test/a.ts#old'] }]);
  });

  test('pending results and changed functions do not establish a detection regression', () => {
    const entry: ReportEntry = { mutant, status: 'Survived', source: 'run', killedBy: [], coveredBy: [] };
    expect(detectionRegressions([before], [entry])).toHaveLength(1);
    expect(detectionRegressions([before], [{ ...entry, status: 'Pending' }])).toEqual([]);
    expect(detectionRegressions([before], [{ ...entry, mutant: { ...mutant, scope: { ...mutant.scope, hash: 'changed' } } }])).toEqual([]);
    expect(detectionRegressions([], [entry])).toEqual([]);
  });
});
