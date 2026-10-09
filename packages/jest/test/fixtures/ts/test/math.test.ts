import { add, isAdult, LIMIT, type Person } from '../src/math.ts';

const adult: Person = { age: 30 };

test('add', () => {
  expect(add(1, 2)).toBe(3);
});

describe('isAdult', () => {
  test('adult', () => {
    expect(isAdult(adult)).toBe(true);
  });
  test('child', () => {
    expect(isAdult({ age: 3 })).toBe(false);
  });
});

test('limit', () => {
  expect(LIMIT).toBe(20);
});
