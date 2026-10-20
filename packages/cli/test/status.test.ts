import { expect, test } from 'vitest';
import type { MutantStatus } from '@mizchi/mutator-core';
import { isDetected, isUndetected, score } from '../src/status.ts';

const ALL: MutantStatus[] = ['Killed', 'Survived', 'NoCoverage', 'Timeout', 'RuntimeError', 'Ignored', 'CompileError', 'Pending'];

test('a mutant is detected when a test failed, timed out or crashed on it', () => {
  expect(ALL.filter(isDetected)).toEqual(['Killed', 'Timeout', 'RuntimeError']);
});

test('a mutant is undetected when it survived or no test reached it', () => {
  expect(ALL.filter(isUndetected)).toEqual(['Survived', 'NoCoverage']);
});

test('the score is detected over detected and undetected; other statuses do not count', () => {
  const entries = (...statuses: MutantStatus[]) => statuses.map((status) => ({ status }));
  expect(score(entries('Killed', 'Timeout', 'Survived', 'NoCoverage', 'Ignored', 'CompileError', 'Pending'))).toBe(0.5);
  expect(score(entries('RuntimeError', 'Survived', 'Survived'))).toBeCloseTo(1 / 3);
  expect(score(entries('Ignored', 'Pending'))).toBe(1);
  expect(score([])).toBe(1);
});
