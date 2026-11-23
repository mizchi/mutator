import { expect, test } from 'vitest';
import { total } from '../src/parse.ts';

// Tests that set environment variables must keep working under the read tracker.
test('assigns, reassigns and deletes environment variables', () => {
  process.env.MUTATOR_WRITES_FLAG = 'a';
  process.env.MUTATOR_WRITES_FLAG = 'b';
  Object.assign(process.env, { MUTATOR_WRITES_OTHER: '1' });
  delete process.env.MUTATOR_WRITES_FLAG;
  delete process.env.MUTATOR_WRITES_OTHER;
  expect(total([1])).toBe(1);
});
