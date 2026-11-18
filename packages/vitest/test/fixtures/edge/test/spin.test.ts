import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { countdown } from '../src/spin.ts';

test('countdown', () => {
  if (process.env.MUTATOR_TEST_WORKER_PID) writeFileSync(process.env.MUTATOR_TEST_WORKER_PID, String(process.pid));
  expect(countdown(3)).toBe(0);
});
