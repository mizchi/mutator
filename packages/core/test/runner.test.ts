import { expect, test } from 'vitest';
import { hash } from '../src/hash.ts';
import { instrumentFlags, testFingerprint } from '../src/runner.ts';

test("a test's fingerprint changes with its file's content and with its id", () => {
  expect(testFingerprint('h1', 'a.test.ts#adds')).toBe(hash('h1\0a.test.ts#adds'));
  expect(testFingerprint('h2', 'a.test.ts#adds')).not.toBe(testFingerprint('h1', 'a.test.ts#adds'));
  expect(testFingerprint('h1', 'a.test.ts#subtracts')).not.toBe(testFingerprint('h1', 'a.test.ts#adds'));
});

test('instrumentFlags keeps the instrument options that are set and nothing else', () => {
  const mutators = [{ name: 'Custom', visit: () => [] }] as never;
  expect(instrumentFlags({ arid: false, weak: false, excludedMutators: ['Regex'], mutators, targets: ['/p/a.ts'] } as never)).toEqual({
    arid: false,
    weak: false,
    excludedMutators: ['Regex'],
    mutators,
  });
  expect(instrumentFlags({ arid: undefined, ignorers: undefined } as never)).toEqual({});
  expect(Object.keys(instrumentFlags({ arid: undefined } as never))).toEqual([]);
});
