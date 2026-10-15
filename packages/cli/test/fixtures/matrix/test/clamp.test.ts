import { expect, test } from 'vitest';
import { clamp } from '../src/clamp.ts';

// Kills every mutant `below` kills, and more.
test('thorough', () => {
  expect(clamp(-1, 0, 10)).toBe(0);
  expect(clamp(0, 0, 10)).toBe(0);
  expect(clamp(5, 0, 10)).toBe(5);
  expect(clamp(10, 0, 10)).toBe(10);
  expect(clamp(11, 0, 10)).toBe(10);
});

test('below', () => {
  expect(clamp(-1, 0, 10)).toBe(0);
});

// Runs the code but asserts nothing.
test('smoke', () => {
  clamp(5, 0, 10);
});
