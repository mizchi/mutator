import { getSize } from '../src/config.js';

test('a', () => {
  expect(getSize()).toBe(3);
});
