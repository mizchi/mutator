import { expect, test } from 'vitest';
import { double, isPositive } from '../src/a.ts';
import { NEGATIVE } from './helper.ts';

test('double', () => {
  expect(double(2)).toBe(4);
});

test('isPositive', () => {
  expect(isPositive(1)).toBe(true);
  expect(isPositive(NEGATIVE)).toBe(false);
});

test('combo', () => {
  expect(isPositive(double(1))).toBe(true);
});
