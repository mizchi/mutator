import { expect, test } from 'bun:test';
import { check } from '../src/guard.ts';

test('check', () => {
  expect(check(true)).toBe(true);
});
