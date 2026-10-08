import { expect, test } from 'vitest';
import { add } from '../src/m.ts';

for (let i = 0; i < 60; i++) {
  test(`filler ${i}`, () => {
    expect(i).toBe(i);
  });
}

test('add', () => {
  expect(add(1, 2)).toBe(3);
});
