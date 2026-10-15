import { expect, test } from 'vitest';
import { clamp } from '../src/clamp.ts';

// The same check as `below`, in another file.
test('below again', () => {
  expect(clamp(-1, 0, 10)).toBe(0);
});
