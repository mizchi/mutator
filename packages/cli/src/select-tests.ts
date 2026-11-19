// select-tests: the tests a change can break, ranked from a warm snapshot without running anything.
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type MutantResult, testFileOf, relativePath as relative } from '@mizchi/mutator-core';
import { extractScopes, selectAffectedTests } from '@mizchi/test-impact';
import { loadersOf } from './consumers.ts';
import { loadWarmSnapshot } from './reuse.ts';
import type { RunOptions } from './run.ts';
import { TEST_FILE, changesSince } from './since.ts';

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
  /** Sources whose test impact can be narrowed to individual scopes, relative to root. */
  sources: ReadonlySet<string>;
  /** The snapshot's test files (relative) and the local files each imports. */
  testFiles: Readonly<Record<string, unknown>>;
  deps: Readonly<Record<string, readonly string[]>>;
  sourceCoverage?: Readonly<Record<string, readonly string[]>>;
  sourceCoverageIncomplete?: readonly string[];
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
  /** 3. Changed test files and importers of changed helpers, removed files or lost bindings. */
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
  // Scope coverage also sees code without mutants. Retain incomplete collectors
  // as candidates: a missing observation is not evidence that they cannot reach it.
  for (const [file, ids] of scopes) {
    const rel = relative(root, file);
    for (const id of [...ids].sort()) {
      const at = `${rel}#${id}`;
      const observed = input.sourceCoverage?.[at]?.filter((t) => present.has(t));
      for (const test of observed ?? []) {
        if (!kills.has(test) && !covers.has(test)) covering.push({ test, file: testFileOf(test), reason: `executed ${at}` });
      }
      for (const test of input.sourceCoverageIncomplete ?? []) {
        const module = testFileOf(test);
        if (present.has(test) && input.deps[module]?.includes(rel) && !kills.has(test) && !covers.has(test) && !observed?.includes(test)) covering.push({ file: module, reason: `incomplete source coverage for ${at}` });
      }
      if (seen.has(`${file}#${id}`)) continue;
      if (observed?.length) continue;
      const loaders = loadersOf(rel, input.deps, input.testFiles);
      if (input.sourceCoverage && loaders.length === 0) {
        for (const file of Object.keys(input.testFiles).sort()) covering.push({ file, reason: `no source coverage for ${at}` });
      } else {
        for (const loader of loaders) covering.push({ file: loader, reason: `imports ${rel} (no snapshot data for ${id})` });
      }
    }
  }

  const changedTests: Picked[] = input.changed.filter((f) => f in input.testFiles || TEST_FILE.test(f)).map((file) => ({ file, reason: 'changed' }));
  const direct = new Set(changedTests.map((p) => p.file));
  for (const f of input.changed) {
    if (input.sources.has(f)) continue;
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
  const warm = await loadWarmSnapshot(options);
  if (!warm) {
    const { matches } = await selectAffectedTests({ root, since: options.since });
    return { killers: [], covering: matches.filter(m => m.reason !== 'changed'), changedTests: matches.filter(m => m.reason === 'changed') };
  }
  const { snapshot, files } = warm;
  const { lines, removed } = changesSince(root, options.since);
  const changed = [...new Set([...lines.keys(), ...removed])].sort();
  const scopedSources = new Set(files.map(file => relative(root, file)));
  const historical = Map.groupBy(snapshot.results, result => result.file);
  const scopes = new Map<string, Set<string>>();
  for (const rel of changed) {
    const file = join(root, rel);
    const current = scopedSources.has(rel) && lines.has(rel) ? extractScopes(file, readFileSync(file, 'utf8')) : [];
    const currentIds = new Set(current.map((s) => s.id));
    const previous = snapshot.scopes?.[rel];
    const previousIds = snapshot.scopes ? Object.keys(previous ?? {}) : (historical.get(file) ?? []).map(r => r.scopeId);
    const selected = new Set<string>();
    // A removed scope has no new-side mutant or line, but its old results still identify tests.
    const missing = previousIds.filter((id) => !currentIds.has(id));
    for (const id of missing) selected.add(id);
    // Importing or inspecting a removed binding can fail without ever executing its body.
    const bindings = new Set(current.flatMap((scope) => scope.declares ?? []));
    const lostBinding = Object.values(previous ?? {}).some((s) => s.declares?.some((name) => !bindings.has(name)));
    if (!current.length || lostBinding || (!snapshot.scopes && missing.length > 0)) scopedSources.delete(rel);
    const numbers = lines.get(rel);
    if (numbers !== undefined) {
      const historicalIds = new Set(historical.get(file)?.map(result => result.scopeId));
      for (const scope of current) {
        if (!historicalIds.has(scope.id) && previous?.[scope.id]?.hash === scope.hash) continue;
        if (numbers === null || numbers.some(line => scope.location.start.line <= line && line <= scope.location.end.line)) selected.add(scope.id);
      }
    }
    if (selected.size) scopes.set(file, selected);
  }
  const selection = selectTests({
    root,
    results: snapshot.results,
    tests: snapshot.tests,
    scopes,
    changed,
    sources: scopedSources,
    testFiles: snapshot.testFiles,
    deps: snapshot.deps,
    ...(snapshot.sourceCoverage ? { sourceCoverage: snapshot.sourceCoverage, sourceCoverageIncomplete: snapshot.sourceCoverageIncomplete ?? [] } : {}),
  });
  // Test files deleted since the snapshot cannot run.
  const exists = (p: Picked) => statSync(join(root, p.file), { throwIfNoEntry: false })?.isFile();
  return { killers: selection.killers.filter(exists), covering: selection.covering.filter(exists), changedTests: selection.changedTests.filter(exists) };
}
