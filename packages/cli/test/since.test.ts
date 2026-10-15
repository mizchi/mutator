import { expect, test } from 'vitest';
import { uncollectedTests } from '../src/since.ts';

test('changed test files the runner did not collect', () => {
  const changed = ['test/a.test.ts', 'test/b.spec.mjs', 'src/__tests__/c.ts', 'test/helper.ts', 'src/a.ts', 'test/fixtures/x.test.ts.snap'];
  expect(uncollectedTests(changed, new Set(['test/a.test.ts']))).toEqual(['src/__tests__/c.ts', 'test/b.spec.mjs']);
});
