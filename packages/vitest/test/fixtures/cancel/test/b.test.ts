import { expect, test } from 'vitest';
import { ready } from '../src/boot.ts';

test('boots', () => {
  expect(ready).toBe(true);
});
