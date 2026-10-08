import { expect, test } from 'vitest';
import { isPos } from '../src/sign.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.concurrent('pos', async () => {
  await sleep(5);
  expect(isPos(1)).toBe(true);
});

test.concurrent('neg', async () => {
  await sleep(40);
  expect(isPos(-1)).toBe(false);
});
