import { describe, expect, test } from 'vitest';
import { add, isAdult, LIMIT } from '../src/math.ts';

test('add', () => {
  expect(add(1, 2)).toBe(3);
});

describe('isAdult', () => {
  test('adult', () => {
    expect(isAdult(30)).toBe(true);
  });
  test('child', () => {
    expect(isAdult(3)).toBe(false);
  });
});

test('limit', () => {
  expect(LIMIT).toBe(20);
});
