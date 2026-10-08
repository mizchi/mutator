import { expect, test } from 'vitest';
import { greet } from '../src/b.ts';

test('greet', () => {
  expect(greet('a')).toBe('hello a');
  expect(greet('')).toBe('hello');
});
