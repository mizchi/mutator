import { expect, test } from '@playwright/test';

test('passes', () => {
  expect(1 + 1).toBe(2);
});

test('fails', () => {
  expect(1 + 1).toBe(3);
});
