import { expect, test } from 'bun:test';
import { SIZE } from '../src/config.ts';

test('a', () => {
  expect(SIZE).toBeGreaterThan(0);
});
