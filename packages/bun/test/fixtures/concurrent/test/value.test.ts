import { expect, test } from 'bun:test';
import { double, triple } from '../src/value.ts';

const later = () => new Promise((resolve) => setTimeout(resolve, 20));

test.concurrent('double', async () => {
  await later();
  expect(double(2)).toBe(4);
});

test.concurrent('triple', async () => {
  await later();
  expect(triple(2)).toBe(6);
});
