import { expect, test } from 'vitest';
import type { Mutant } from '@mizchi/mutator-core';
import { Tally, resultOf } from '../src/tally.ts';

const mutant = {
  key: 'k1',
  file: '/p/a.ts',
  scope: { id: 'f', hash: 'h' },
  location: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
} as unknown as Mutant;

test("a settled verdict is the report entry at its index and the snapshot's result, in settling order", () => {
  const tally = new Tally();
  tally.hold(0, { mutant, status: 'Pending', source: 'run', killedBy: [], coveredBy: ['t1'] });
  tally.settle(1, { mutant: { ...mutant, key: 'k2' }, status: 'NoCoverage', source: 'static', killedBy: [], coveredBy: [] });
  tally.settle(0, { mutant, status: 'Killed', source: 'run', killedBy: ['t1'], coveredBy: ['t1'], matrix: true });
  expect(tally.report.map((e) => [e.mutant.key, e.status])).toEqual([
    ['k1', 'Killed'],
    ['k2', 'NoCoverage'],
  ]);
  expect(tally.results.map((r) => [r.key, r.status])).toEqual([
    ['k2', 'NoCoverage'],
    ['k1', 'Killed'],
  ]);
});

test('the result carries the verdict, the tests, the reason and the matrix flag of the entry', () => {
  expect(resultOf({ mutant, status: 'Killed', source: 'run', killedBy: ['t1'], coveredBy: ['t1', 't2'], matrix: true }, { durationMs: 12 })).toEqual({
    key: 'k1',
    file: '/p/a.ts',
    scopeId: 'f',
    scopeHash: 'h',
    status: 'Killed',
    killedBy: ['t1'],
    coveredBy: ['t1', 't2'],
    durationMs: 12,
    matrix: true,
  });
  expect(resultOf({ mutant, status: 'Survived', source: 'static', killedBy: [], coveredBy: ['t1'], reason: 'notInfected' })).toMatchObject({ status: 'Survived', reason: 'notInfected', coveredBy: ['t1'] });
  // An ignored mutant's coverage is not kept.
  expect(resultOf({ mutant, status: 'Ignored', source: 'static', killedBy: [], coveredBy: ['t1'] }, { coveredBy: [] }).coveredBy).toEqual([]);
});

test('a skipped mutant is Pending and keeps its coverage for the next run', () => {
  const tally = new Tally();
  tally.skip(0, mutant, ['t1']);
  expect(tally.report[0]).toEqual({ mutant, status: 'Pending', source: 'skipped', killedBy: [], coveredBy: ['t1'] });
  expect(tally.results[0]).toMatchObject({ status: 'Pending', coveredBy: ['t1'] });
});
