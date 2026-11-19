import { existsSync, writeFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

// State a test leaves behind: when the session test names a marker file, this test fails the
// first time a mutant run reaches it and passes after that.
test('once', () => {
  const marker = process.env.MUTATOR_TEST_ONCE;
  const firstTime = marker !== undefined && process.env.MUTATOR_ACTIVE !== undefined && !existsSync(marker);
  if (firstTime) writeFileSync(marker, '');
  expect(firstTime).toBe(false);
});
