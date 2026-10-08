import { expect, test } from 'vitest';
import { countdown } from '../src/spin.ts';

test('countdown', () => {
  expect(countdown(3)).toBe(0);
});
