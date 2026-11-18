import { expect, inject, test } from 'vitest';
import { add, LIMIT } from '../src/math.ts';

test('add', () => {
  expect((globalThis as any).projectRole).toBe(inject('role'));
  expect(add(1, 2)).toBe(3);
});
test('limit', () => {
  expect(LIMIT).toBe(6);
});
