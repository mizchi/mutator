// --since: which mutants the diff touches, and which outside it must be rechecked.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Mutant, type MutantResult, type Range, type SelectMode, changedLines, lineRanges, parseUnifiedDiff, selectMutants } from '@mizchi/mutator-core';
import { changedFiles, gitDiff } from './git.ts';

/** Keys of the mutants touched by the diff. */
export function diffTouched(root: string, since: string, mutants: readonly Mutant[], mode: SelectMode): Set<string> {
  const changed = new Map<string, readonly Range[]>();
  for (const fd of parseUnifiedDiff(gitDiff(root, since))) {
    if (!fd.newPath) continue;
    const file = join(root, fd.newPath);
    if (!existsSync(file)) continue;
    changed.set(file, lineRanges(readFileSync(file, 'utf8'), changedLines(fd)));
  }
  for (const rel of changedFiles(root, since, { untracked: true })) {
    const file = join(root, rel);
    if (!changed.has(file) && existsSync(file)) changed.set(file, [{ start: 0, end: readFileSync(file, 'utf8').length }]);
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
