import { expect, test } from 'bun:test';
import { stripNul } from '../src/scheme.ts';

// Fails on the same mutant, ahead of the test below.
test('first', () => {
  expect(stripNul('\0x')).toBe('x');
});

// The report drops the NUL from this test's name.
test('\0javascript:', () => {
  expect(stripNul('\0javascript:')).toBe('javascript:');
});

test('plain', () => {
  expect(stripNul('a')).toBe('a');
});
