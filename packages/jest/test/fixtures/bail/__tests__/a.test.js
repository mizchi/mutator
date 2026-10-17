import { add } from '../src/app.js';

// Slow and passing under every mutant: Jest runs the slowest file of the previous run
// first, so this file has finished before b or c ends the run.
test('a', () => {
  const until = Date.now() + 500;
  while (Date.now() < until) {
    // busy wait
  }
  expect(add(0, 0)).toBe(0);
});
