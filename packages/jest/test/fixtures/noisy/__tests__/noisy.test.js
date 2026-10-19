import { double } from '../src/double.js';

// Writes past a pipe's buffer (64 KB) straight to stdout, which --silent does not stop: a
// session that piped Jest's stdout without reading it would block this process on Linux.
test('double', () => {
  process.stdout.write('x'.repeat(1024 * 1024));
  expect(double(2)).toBe(4);
});
