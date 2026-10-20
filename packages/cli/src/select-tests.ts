// select-tests: the tests a change can break, ranked from a warm snapshot without running anything.
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { type MutantResult, testFileOf } from '@mizchi/mutator-core';
import { loadersOf } from './consumers.ts';
import { loadWarmSnapshot } from './reuse.ts';
import type { RunOptions } from './run.ts';
import { TEST_FILE, diffLines, diffTouched } from './since.ts';

export interface SelectionInput {
  root: string;
  /** The snapshot's results (absolute files). */
  results: readonly MutantResult[];
  /** Tests collected by the run that wrote the snapshot. */
  tests: readonly { id: string }[];
  /** Changed scopes: absolute file -> scope ids (matched by id: changed code has a new hash). */
  scopes: ReadonlyMap<string, ReadonlySet<string>>;
  /** Files of the diff, relative to root. */
  changed: readonly string[];
  /** Mutated sources, relative to root. */
  sources: ReadonlySet<string>;
  /** The snapshot's test files (relative) and the local files each imports. */
  testFiles: Readonly<Record<string, unknown>>;
  deps: Readonly<Record<string, readonly string[]>>;
}

/** A selected test, or a whole test file when `test` is absent. */
export interface Picked {
  test?: string;
  file: string;
  /** Mutants in the changed scopes this test killed (first killer only: runs stop early). */
  kills?: number;
  /** Mutants in the changed scopes this test executed. */
  covers?: number;
  reason: string;
}

export interface Selection {
  /** 1. Killers of mutants in the changed scopes, most kills first. */
  killers: Picked[];
  /** 2. Other tests covering the changed scopes; test files importing changed code the snapshot has no data for. */
  covering: Picked[];
  /** 3. Changed test files, and test files importing changed non-source files (helpers, fixtures). */
  changedTests: Picked[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function selectTests(input: SelectionInput): Selection {
  const { root, scopes } = input;
  const present = new Set(input.tests.map((t) => t.id));
  const kills = new Map<string, number>();
  const covers = new Map<string, number>();
  const where = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const bump = (counts: Map<string, number>, test: string, at: string) => {
    if (!present.has(test)) return;
    counts.set(test, (counts.get(test) ?? 0) + 1);
    where.set(test, (where.get(test) ?? new Set()).add(at));
  };
  for (const r of input.results) {
    if (!scopes.get(r.file)?.has(r.scopeId)) continue;
    const at = `${relative(root, r.file)}#${r.scopeId}`;
    seen.add(`${r.file}#${r.scopeId}`);
    for (const t of new Set(r.killedBy)) bump(kills, t, at);
    for (const t of new Set(r.coveredBy)) bump(covers, t, at);
  }
  const rank = (counts: Map<string, number>) => [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || (covers.get(b) ?? 0) - (covers.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  const scopesOf = (test: string) => [...where.get(test)!].sort().join(', ');

  const killers = rank(kills).map((test) => ({
    test,
    file: testFileOf(test),
    kills: kills.get(test)!,
    covers: covers.get(test) ?? 0,
    reason: `killed ${plural(kills.get(test)!, 'mutant')} in ${scopesOf(test)}`,
  }));
  const covering: Picked[] = rank(new Map([...covers].filter(([t]) => !kills.has(t)))).map((test) => ({
    test,
    file: testFileOf(test),
    covers: covers.get(test)!,
    reason: `covers ${plural(covers.get(test)!, 'mutant')} in ${scopesOf(test)}`,
  }));
  // Scopes the snapshot has no results for (new functions, new files): whoever imports the file.
  for (const [file, ids] of scopes) {
    const rel = relative(root, file);
    for (const id of [...ids].sort()) {
      if (seen.has(`${file}#${id}`)) continue;
      for (const loader of loadersOf(rel, input.deps, input.testFiles)) covering.push({ file: loader, reason: `imports ${rel} (no snapshot data for ${id})` });
    }
  }

  const changedTests: Picked[] = input.changed.filter((f) => f in input.testFiles || TEST_FILE.test(f)).map((file) => ({ file, reason: 'changed' }));
  const direct = new Set(changedTests.map((p) => p.file));
  for (const f of input.changed) {
    if (direct.has(f) || input.sources.has(f)) continue;
    for (const loader of loadersOf(f, input.deps, input.testFiles)) {
      if (!direct.has(loader)) changedTests.push({ file: loader, reason: `imports ${f}` });
    }
  }
  return { killers, covering, changedTests };
}

/** Unique test files in rank order (for `vitest run $(mutator select-tests ...)`). */
export function selectionFiles(selection: Selection): string[] {
  return [...new Set([...selection.killers, ...selection.covering, ...selection.changedTests].map((p) => p.file))];
}

/**
 * The selection for the diff against `since`, from the warm snapshot. Scopes are taken whole
 * (as with `--scope scope`): an edit on a line without mutants still selects its function.
 */
export async function selectTestsSince(options: RunOptions & { since: string }): Promise<Selection> {
  const root = resolve(options.root);
  const { snapshot, mutants } = await loadWarmSnapshot(options);
  const lines = diffLines(root, options.since);
  const touched = diffTouched(root, lines, mutants, 'scope');
  const scopes = new Map<string, Set<string>>();
  for (const m of mutants) if (touched.has(m.key)) scopes.set(m.file, (scopes.get(m.file) ?? new Set()).add(m.scope.id));
  const selection = selectTests({
    root,
    results: snapshot.results,
    tests: snapshot.tests,
    scopes,
    changed: [...lines.keys()].sort(),
    sources: new Set(mutants.map((m) => relative(root, m.file))),
    testFiles: snapshot.testFiles,
    deps: snapshot.deps,
  });
  // Test files deleted since the snapshot cannot run.
  const exists = (p: Picked) => existsSync(join(root, p.file));
  return { killers: selection.killers.filter(exists), covering: selection.covering.filter(exists), changedTests: selection.changedTests.filter(exists) };
}
