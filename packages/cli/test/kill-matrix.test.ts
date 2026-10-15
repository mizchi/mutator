import { describe, expect, test } from 'vitest';
import { type MatrixRow, analyzeKillMatrix, hasFullMatrix } from '../src/kill-matrix.ts';

const killed = (key: string, killedBy: string[], coveredBy: string[] = killedBy): MatrixRow => ({ key, status: 'Killed', killedBy, coveredBy, matrix: true });
const survived = (key: string, coveredBy: string[]): MatrixRow => ({ key, status: 'Survived', killedBy: [], coveredBy });

describe('hasFullMatrix', () => {
  test('a survivor ran every covering test: its (empty) kill set is complete', () => {
    expect(hasFullMatrix(survived('m', ['t#a']))).toBe(true);
    expect(hasFullMatrix({ ...survived('m', ['t#a']), reason: 'notInfected' })).toBe(true);
  });

  test('a kill is complete only when recorded as a matrix', () => {
    expect(hasFullMatrix(killed('m', ['t#a']))).toBe(true);
    expect(hasFullMatrix({ key: 'm', status: 'Killed', killedBy: ['t#a'], coveredBy: ['t#a'] })).toBe(false);
  });

  test('a kill attributed to a whole test file (a module error) cannot be split by test', () => {
    expect(hasFullMatrix(killed('m', ['t#a', 'test/t.test.ts']))).toBe(false);
  });

  test('timeouts, runtime errors and mutants not run have no matrix', () => {
    for (const status of ['Timeout', 'RuntimeError', 'Pending', 'NoCoverage', 'CompileError', 'Ignored'] as const) {
      expect(hasFullMatrix({ key: 'm', status, killedBy: [], coveredBy: ['t#a'], matrix: true })).toBe(false);
    }
  });
});

describe('analyzeKillMatrix', () => {
  test('a covering test that kills nothing detects nothing mutation can observe', () => {
    const analysis = analyzeKillMatrix([killed('m1', ['t#strong'], ['t#strong', 't#weak']), survived('m2', ['t#weak'])]);
    expect(analysis.noKills).toEqual(['t#weak']);
    expect(analysis.tests).toBe(2);
  });

  test('a test whose kills are a strict subset of another test is subsumed by it', () => {
    const analysis = analyzeKillMatrix([killed('m1', ['t#big', 't#small']), killed('m2', ['t#big']), killed('m3', ['t#big', 't#other'])]);
    expect(analysis.subsumed).toEqual([
      { test: 't#other', kills: 1, by: ['t#big'] },
      { test: 't#small', kills: 1, by: ['t#big'] },
    ]);
    expect(analysis.duplicates).toEqual([]);
  });

  test('subsumers are listed largest first', () => {
    const analysis = analyzeKillMatrix([killed('m1', ['t#a', 't#b', 't#c']), killed('m2', ['t#a', 't#b']), killed('m3', ['t#a'])]);
    expect(analysis.subsumed).toEqual([
      { test: 't#b', kills: 2, by: ['t#a'] },
      { test: 't#c', kills: 1, by: ['t#a', 't#b'] },
    ]);
  });

  test('tests with identical kill sets are grouped as duplicates, not subsumed by each other', () => {
    const analysis = analyzeKillMatrix([killed('m1', ['t#x', 't#y', 't#z']), killed('m2', ['t#x', 't#y']), killed('m3', ['t#z'])]);
    expect(analysis.duplicates).toEqual([{ tests: ['t#x', 't#y'], kills: 2 }]);
    expect(analysis.subsumed).toEqual([]);
  });

  test('a duplicate group can itself be subsumed', () => {
    const analysis = analyzeKillMatrix([killed('m1', ['t#all', 't#x', 't#y']), killed('m2', ['t#all'])]);
    expect(analysis.duplicates).toEqual([{ tests: ['t#x', 't#y'], kills: 1 }]);
    expect(analysis.subsumed.map((s) => s.test)).toEqual(['t#x', 't#y']);
  });

  test('only mutants with a full matrix count; timeouts and partial kills are excluded and counted', () => {
    const analysis = analyzeKillMatrix([
      killed('m1', ['t#a']),
      { key: 'm2', status: 'Timeout', killedBy: [], coveredBy: ['t#b'] },
      { key: 'm3', status: 'Killed', killedBy: ['t#b'], coveredBy: ['t#b', 't#a'] },
      { key: 'm4', status: 'Pending', killedBy: [], coveredBy: ['t#c'] },
      { key: 'm5', status: 'NoCoverage', killedBy: [], coveredBy: [] },
    ]);
    // t#b only covers mutants without a matrix: it is not judged at all.
    expect(analysis.tests).toBe(1);
    expect(analysis.noKills).toEqual([]);
    expect(analysis.mutants).toEqual({ full: 1, timeout: 1, incomplete: 2 });
  });

  test('no full matrix: nothing to report', () => {
    expect(analyzeKillMatrix([])).toEqual({ mutants: { full: 0, timeout: 0, incomplete: 0 }, tests: 0, noKills: [], subsumed: [], duplicates: [] });
  });
});
