import { add, exitOnError } from '../src/app.js';

test('b ok', () => {
  expect(add(0, 0)).toBe(0);
});

test('b add', () => {
  expect(add(1, 2)).toBe(3);
});

test('b exit', () => {
  expect(exitOnError(0)).toBe(0);
});
