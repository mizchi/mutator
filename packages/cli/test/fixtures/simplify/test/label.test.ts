import { expect, test } from 'vitest';
import { label, sign } from '../src/label.js';

test('label trims the name', () => {
  expect(label('')).toBe('');
  expect(label('  ada ')).toBe('ada');
});

test('sign', () => {
  expect(sign(-3)).toBe(-1);
  expect(sign(3)).toBe(1);
});
