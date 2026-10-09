import { applyMutant } from '@mizchi/mutator-core';
import type { TypecheckMutant } from './types.ts';

/** The first diagnostic in `current` that `baseline` does not account for (multiset difference). */
export function firstNewError(baseline: readonly string[], current: readonly string[]): string | undefined {
  const remaining = new Map<string, number>();
  for (const d of baseline) remaining.set(d, (remaining.get(d) ?? 0) + 1);
  for (const d of current) {
    const n = remaining.get(d) ?? 0;
    if (n === 0) return d;
    remaining.set(d, n - 1);
  }
  return undefined;
}

/**
 * Shared driver: for every mutant, swap its file's text, collect diagnostics of
 * that file (as `code message` strings, positions ignored), compare with the
 * original diagnostics, and restore the file.
 */
export function checkEach(
  mutants: readonly TypecheckMutant[],
  read: (file: string) => string,
  diagnose: (file: string, text: string | undefined) => string[],
): Map<string, string> {
  const result = new Map<string, string>();
  const baseline = new Map<string, string[]>();
  for (const m of mutants) {
    let before = baseline.get(m.file);
    if (!before) {
      before = diagnose(m.file, undefined);
      baseline.set(m.file, before);
    }
    const error = firstNewError(before, diagnose(m.file, applyMutant(read(m.file), m)));
    if (error) result.set(m.key, error);
  }
  for (const file of baseline.keys()) diagnose(file, undefined);
  return result;
}
