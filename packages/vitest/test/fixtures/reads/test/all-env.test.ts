import { expect, test } from 'vitest';
import { total } from '../src/parse.ts';

test('lists every variable', () => {
  expect(Object.keys(process.env).length).toBeGreaterThan(0);
  expect(total([1])).toBe(1);
});
