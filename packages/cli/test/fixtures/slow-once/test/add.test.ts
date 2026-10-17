import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { add } from '../src/add.ts';

// Simulates a machine that is busy during one mutant run: with MUTATOR_SLOW_ONCE set to a
// counter file, the test's second run (the first mutant run after the dry run) sleeps.
test('add', async () => {
  const counter = process.env.MUTATOR_SLOW_ONCE;
  if (counter) {
    const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
    writeFileSync(counter, String(n));
    if (n === 2) await new Promise((resolve) => setTimeout(resolve, 6000));
  }
  expect(add(1, 2)).toBe(3);
});
