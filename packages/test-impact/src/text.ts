// Source text helpers: offset ranges and line positions.
import type { Range } from './types.ts';

/** Overlap of half-open ranges; an empty range is a point and touches a range at either edge. */
export function intersects(a: Range, b: Range): boolean {
  if (a.start === a.end) return b.start <= a.start && a.start <= b.end;
  if (b.start === b.end) return a.start <= b.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

/** Offset of the first character of each line (`\n` separated; a `\r` stays at the end of its line). */
export function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 1-based line and 0-based column of `offset`. */
export function position(starts: readonly number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! };
}
