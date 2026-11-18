import { expect, test } from 'vitest';
import { add } from '../src/add.ts';

test('add', () => {
  expect(add(2, 3)).toBe(5);
});
