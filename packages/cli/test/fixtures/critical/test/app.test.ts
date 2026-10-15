import { expect, test } from 'vitest';
import { canEdit } from '../src/auth/roles.js';
import { label, total } from '../src/price.js';

test('canEdit', () => {
  expect(canEdit('admin')).toBe(true);
});

test('total', () => {
  expect(total(2, 3)).toBeGreaterThan(0);
});

test('label', () => {
  expect(typeof label('x')).toBe('string');
});
