import { describe, expect, test } from 'bun:test';
import { LIMIT, add, countdown, isAdult } from '../src/math.ts';

test('add', () => {
  expect(add(1, 2)).toBe(3);
});

describe('isAdult', () => {
  test('adult', () => {
    expect(isAdult(30)).toBe(true);
  });
  test.skip('skipped', () => {});
  test('child', () => {
    expect(isAdult(3)).toBe(false);
  });
});

test('limit', () => {
  expect(LIMIT).toBe(20);
});

test('countdown', () => {
  expect(countdown(3)).toBe(0);
});
