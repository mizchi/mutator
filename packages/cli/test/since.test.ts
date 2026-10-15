import { expect, test } from 'vitest';
import { skippedTests, uncollectedTests } from '../src/since.ts';

test('changed test files the runner did not collect', () => {
  const changed = ['test/a.test.ts', 'test/b.spec.mjs', 'src/__tests__/c.ts', 'test/helper.ts', 'src/a.ts', 'test/fixtures/x.test.ts.snap'];
  expect(uncollectedTests(changed, new Set(['test/a.test.ts']))).toEqual(['src/__tests__/c.ts', 'test/b.spec.mjs']);
});

test('skipped or todo tests on the changed lines of a test file', () => {
  const source = ["it('a', () => {});", "it.skip('b', () => {});", "test.todo('c');", "xit('d', () => {});", "describe.skip('e', () => {});", "// it.skip('f')"].join('\n');
  expect(skippedTests('test/a.test.ts', source, [1, 2, 3, 4, 5])).toEqual([
    { file: 'test/a.test.ts', line: 2, text: "it.skip('b', () => {});" },
    { file: 'test/a.test.ts', line: 3, text: "test.todo('c');" },
    { file: 'test/a.test.ts', line: 4, text: "xit('d', () => {});" },
    { file: 'test/a.test.ts', line: 5, text: "describe.skip('e', () => {});" },
  ]);
  expect(skippedTests('test/a.test.ts', source, [1])).toEqual([]);
  expect(skippedTests('src/a.ts', source, [2])).toEqual([]);
});
