import { expect, test } from 'vitest';
import { positive } from '../src/positive.ts';

// Misses the boundary on purpose: `x > 0` -> `x >= 0` survives.
test('positive', () => {
  expect(positive(5)).toBe(true);
});
