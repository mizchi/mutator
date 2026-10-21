import { describe, expect, test } from 'vitest';
import { intersects, lineStarts, position } from '../src/text.ts';

describe('intersects', () => {
  const r = (start: number, end: number) => ({ start, end });

  test('non-empty ranges are half-open', () => {
    expect(intersects(r(0, 5), r(4, 6))).toBe(true);
    expect(intersects(r(0, 5), r(5, 6))).toBe(false);
  });

  test('an empty range is a point touching either edge, on either side', () => {
    for (const p of [2, 5, 9]) {
      expect(intersects(r(p, p), r(2, 9))).toBe(true);
      expect(intersects(r(2, 9), r(p, p))).toBe(true);
    }
    expect(intersects(r(10, 10), r(2, 9))).toBe(false);
    expect(intersects(r(2, 9), r(1, 1))).toBe(false);
  });
});

describe('lineStarts / position', () => {
  test('1-based lines, 0-based columns; \\r stays on its line', () => {
    const starts = lineStarts('ab\r\ncd\n');
    expect(starts).toEqual([0, 4, 7]);
    expect(position(starts, 0)).toEqual({ line: 1, column: 0 });
    expect(position(starts, 2)).toEqual({ line: 1, column: 2 });
    expect(position(starts, 5)).toEqual({ line: 2, column: 1 });
    expect(position(starts, 7)).toEqual({ line: 3, column: 0 });
  });
});
