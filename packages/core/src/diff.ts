// Unified diff parsing and diff-scoped mutant selection. Pure: callers supply diff text and sources.
import { intersects, lineStarts } from './text.ts';
import type { Range } from './types.ts';

export { type DiffHunk, type FileDiff, parseUnifiedDiff, changedLines } from '@mizchi/test-impact/source';
export type SelectMode = 'node' | 'scope';

export function lineRanges(source: string, lines: readonly number[]): Range[] {
  const starts = lineStarts(source);
  const lineEnd = (n: number) => {
    const next = starts[n];
    if (next === undefined) return source.length;
    return source[next - 2] === '\r' ? next - 2 : next - 1;
  };
  const wanted = [...new Set(lines)].filter((n) => n >= 1 && n <= starts.length).sort((a, b) => a - b);
  const out: Range[] = [];
  let prev = -1;
  for (const n of wanted) {
    const last = out.at(-1);
    if (last && n === prev + 1) last.end = lineEnd(n);
    else out.push({ start: starts[n - 1]!, end: lineEnd(n) });
    prev = n;
  }
  return out;
}

// ---- selection --------------------------------------------------------------

export function selectMutants<M extends { file: string; range: Range; scope: { range: Range } }>(
  mutants: readonly M[],
  changed: ReadonlyMap<string, readonly Range[]>,
  mode: SelectMode,
): M[] {
  return mutants.filter((m) => {
    const ranges = changed.get(m.file);
    if (!ranges) return false;
    const target = mode === 'scope' ? m.scope.range : m.range;
    return ranges.some((r) => intersects(r, target));
  });
}
