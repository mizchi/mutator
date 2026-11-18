import { expect, test } from 'vite-plus/test';
import { add, isAdult, LIMIT } from '../src/math.ts';

test('add', () => {
  expect(add(1, 2)).toBe(3);
});

test('adult', () => {
  expect(isAdult(30)).toBe(true);
});

test('limit', () => {
  expect(LIMIT).toBe(20);
});
