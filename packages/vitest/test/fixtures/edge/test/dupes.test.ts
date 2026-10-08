import { expect, test } from 'vitest';
import { isPos } from '../src/sign.ts';

test('case', () => {
  expect(isPos(-1)).toBe(false);
});

test('case', () => {
  expect(isPos(1)).toBe(true);
});
