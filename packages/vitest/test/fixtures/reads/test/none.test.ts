import { expect, test } from 'vitest';
import { total } from '../src/parse.ts';

test('reads nothing', () => {
  expect(total([])).toBe(0);
});
