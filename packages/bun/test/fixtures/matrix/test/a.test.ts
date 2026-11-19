import { expect, test } from 'bun:test';
import { add } from '../src/add.ts';

test('a', () => {
  expect(add(2, 3)).toBe(5);
});
