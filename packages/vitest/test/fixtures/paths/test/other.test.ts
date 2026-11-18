import { expect, test } from 'vitest';
import { add } from '../src/add.ts';

test('other', () => {
  expect(add(0, 0)).toBe(0);
});
