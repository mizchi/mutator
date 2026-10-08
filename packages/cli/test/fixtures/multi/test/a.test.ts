import { expect, test } from 'vitest';
import { double, isPositive } from '../src/a.ts';

test('double', () => {
  expect(double(2)).toBe(4);
});

test('isPositive', () => {
  expect(isPositive(1)).toBe(true);
  expect(isPositive(-1)).toBe(false);
});

test('combo', () => {
  expect(isPositive(double(1))).toBe(true);
});
