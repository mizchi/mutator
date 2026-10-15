// --since: which mutants the diff touches, and which outside it must be rechecked.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Mutant, type MutantResult, type Range, type SelectMode, changedLines, lineRanges, parseUnifiedDiff, selectMutants } from '@mizchi/mutator-core';
import { changedFiles, gitDiff } from './git.ts';

/** Changed files (relative, existing) -> changed line numbers of the new side, or `null` for a whole new (untracked) file. */
export function diffLines(root: string, since: string): Map<string, number[] | null> {
  const out = new Map<string, number[] | null>();
  for (const fd of parseUnifiedDiff(gitDiff(root, since))) {
    if (fd.newPath && existsSync(join(root, fd.newPath))) out.set(fd.newPath, changedLines(fd));
  }
  for (const rel of changedFiles(root, since, { untracked: true })) {
    if (!out.has(rel) && existsSync(join(root, rel))) out.set(rel, null);
  }
  return out;
}

/** Keys of the mutants touched by the diff. */
export function diffTouched(root: string, lines: ReadonlyMap<string, number[] | null>, mutants: readonly Mutant[], mode: SelectMode): Set<string> {
  const changed = new Map<string, readonly Range[]>();
  for (const [rel, numbers] of lines) {
    const source = readFileSync(join(root, rel), 'utf8');
    changed.set(join(root, rel), numbers ? lineRanges(source, numbers) : [{ start: 0, end: source.length }]);
  }
  return new Set(selectMutants(mutants, changed, mode).map((m) => m.key));
}

/**
 * The mutants a --since run reports: those in the diff, and those outside it that were killed
 * before by tests that are all gone now (removed or renamed), so a deleted test cannot hide.
 * Code a changed test merely covers is left out: its survivors predate the change.
 */
export function sinceFocus(touched: ReadonlySet<string>, previous: readonly MutantResult[], tests: readonly { id: string }[]): Map<string, 'diff' | 'recheck'> {
  const focus = new Map<string, 'diff' | 'recheck'>([...touched].map((k) => [k, 'diff']));
  const present = new Set(tests.map((t) => t.id));
  for (const r of previous) {
    if (focus.has(r.key) || r.status !== 'Killed' || r.killedBy.length === 0) continue;
    if (r.killedBy.every((t) => !present.has(t))) focus.set(r.key, 'recheck');
  }
  return focus;
}

const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Changed files that look like tests (`*.test.*`, `*.spec.*`, `__tests__/`) but are not among
 * the runner's test files: they kill nothing, so the mutants only they would kill look undetected.
 */
export function uncollectedTests(changed: readonly string[], collected: ReadonlySet<string>): string[] {
  return changed.filter((f) => TEST_FILE.test(f) && !collected.has(f)).sort();
}

const SKIP = /\b(?:it|test|describe|suite)\.(?:skip|todo)\b|\bx(?:it|test|describe)\s*\(/;

/** Skipped or todo tests on the given lines (1-based) of a test file: a test added that way checks nothing. */
export function skippedTests(file: string, source: string, lines: readonly number[]): { file: string; line: number; text: string }[] {
  if (!TEST_FILE.test(file)) return [];
  const all = source.split('\n');
  return lines.flatMap((line) => {
    const text = all[line - 1]?.trim() ?? '';
    return SKIP.test(text) && !text.startsWith('//') && !text.startsWith('*') ? [{ file, line, text }] : [];
  });
}

/** Skipped or todo tests among the changed lines of the changed test files. */
export function skippedInDiff(root: string, lines: ReadonlyMap<string, number[] | null>): { file: string; line: number; text: string }[] {
  return [...lines].flatMap(([rel, numbers]) => {
    if (!TEST_FILE.test(rel)) return [];
    const source = readFileSync(join(root, rel), 'utf8');
    return skippedTests(rel, source, numbers ?? source.split('\n').map((_, i) => i + 1));
  });
}
