// Decides how much of the coverage (dry) run can be skipped by reusing the previous snapshot.
import { join, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { type ImportBinding, type Mutant, type MutantResult, type RunSnapshot, type Scope, type TestInfo, hash, mergeCoverage, scanImports } from '@mizchi/mutator-core';
import type { DryRunResult, TestLocation } from '@mizchi/mutator-vitest';

/** Snapshot persisted by the CLI: the core run snapshot plus adapter-level coverage data. */
export interface CliSnapshot extends RunSnapshot {
  /** test file (relative) -> content hash */
  testFiles: Record<string, string>;
  /** test id -> location (module relative to root) */
  index: Record<string, { module: string; taskId: string }>;
  /** test file (relative) -> mutant keys hit while loading its modules */
  staticByFile: Record<string, string[]>;
  /** test file (relative) -> local files it imports, including mutated sources */
  deps: Record<string, string[]>;
  hits: Record<string, number>;
  /** source file (relative) -> scope id -> entry */
  scopes?: Record<string, Record<string, ScopeEntry>>;
}

/** A scope as recorded in the snapshot; top-level statements keep what they declare. */
export interface ScopeEntry {
  hash: string;
  declares?: string[];
  pure?: boolean;
}

/** What the dry-run planner needs to know about each mutated source. */
export interface SourceInfo {
  scopes: readonly Scope[];
  imports: readonly ImportBinding[];
  reexports: readonly ImportBinding[];
}

export function scopeTable(root: string, sources: ReadonlyMap<string, SourceInfo>): Record<string, Record<string, ScopeEntry>> {
  return Object.fromEntries(
    [...sources].map(([file, { scopes }]) => [
      relative(root, file),
      Object.fromEntries(scopes.map((s) => [s.id, s.declares ? { hash: s.hash, declares: s.declares, pure: s.pure ?? false } : { hash: s.hash }])),
    ]),
  );
}

/**
 * Content hash of each test file together with the local files it imports.
 * Mutated sources are left out: the dry-run planner follows their edits per scope.
 */
export function testFileHashes(
  root: string,
  testFiles: readonly string[],
  deps: Readonly<Record<string, readonly string[]>>,
  mutated: ReadonlySet<string>,
): Record<string, string> {
  const read = (rel: string) => {
    const file = join(root, rel);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const content = (rel: string) => (mutated.has(rel) ? '' : read(rel));
  return Object.fromEntries(testFiles.map((rel) => [rel, hash([read(rel), ...(deps[rel] ?? []).flatMap((dep) => [dep, content(dep)])].join('\0'))]));
}

export type DryRunPlan =
  | { all: true }
  | {
      all: false;
      /** test files (relative) to re-collect */
      files: string[];
      /** test files (relative) whose tests may behave differently: every result they covered is stale */
      stale: string[];
      /** scopes (`${absolute file}#${scopeId}`) whose code is unchanged but may behave differently */
      impacted: string[];
    };

const isTopLevel = (scopeId: string) => scopeId.startsWith('<top');
const SCRIPT = /\.[cm]?[jt]sx?$/;

/**
 * Which test files to re-collect, comparing the previous snapshot's scopes with the current sources.
 *
 * - An edited function: the test files whose tests covered it (or loaded it).
 * - A removed function: the test files that covered it (an edited same-named callback gets a new id).
 * - A new function: nothing; only edited callers (handled themselves) reach it.
 * - An edited top-level declaration without side effects: the test files covering the
 *   functions that read the names it declares, followed through imports and re-exports.
 * - Anything without coverage to go by (side-effecting top-level code, functions without
 *   mutants, names imported by tests or unmutated helpers): every test file importing the file.
 */
export function planDryRun(input: {
  root: string;
  previous: CliSnapshot | undefined;
  /** tool / env of `previous` match the current run */
  valid: boolean;
  testFiles: Readonly<Record<string, string>>;
  sources: ReadonlyMap<string, SourceInfo>;
  /** Relative import specifier -> one of the mutated files (absolute). */
  resolve: (from: string, specifier: string) => string | undefined;
}): DryRunPlan {
  const { root, previous, testFiles, sources, resolve } = input;
  if (!previous || !input.valid || !previous.scopes) return { all: true };
  const rel = (file: string) => relative(root, file);

  const files = new Set<string>();
  const stale = new Set<string>();
  const impacted = new Set<string>();
  for (const [file, h] of Object.entries(testFiles)) if (previous.testFiles[file] !== h) files.add(file);

  const resultsByScope = new Map<string, MutantResult[]>();
  for (const r of previous.results) {
    if (r.status === 'Ignored') continue;
    const k = `${rel(r.file)}#${r.scopeId}`;
    resultsByScope.set(k, [...(resultsByScope.get(k) ?? []), r]);
  }
  const staticFilesByKey = new Map<string, string[]>();
  for (const [file, keys] of Object.entries(previous.staticByFile)) for (const k of keys) staticFilesByKey.set(k, [...(staticFilesByKey.get(k) ?? []), file]);
  /** Re-collect the test files that ran a scope; false when there is no coverage for it. */
  const recollect = (file: string, scopeId: string): boolean => {
    const results = resultsByScope.get(`${file}#${scopeId}`);
    if (!results) return false;
    for (const r of results) {
      for (const t of r.coveredBy) {
        const module = previous.index[t]?.module;
        if (module) files.add(module);
      }
      for (const f of staticFilesByKey.get(r.key) ?? []) files.add(f);
    }
    return true;
  };
  /** Every test file importing `file` (directly or not) re-collects, and its results are stale. */
  const invalidated = new Set<string>();
  const invalidate = (file: string) => {
    if (invalidated.has(file)) return;
    invalidated.add(file);
    const hit = Object.entries(previous.deps).filter(([, deps]) => deps.includes(file)).map(([t]) => t);
    if (file in testFiles) hit.push(file);
    for (const t of hit) files.add(t), stale.add(t);
  };

  const current = new Map([...sources].map(([file, info]) => [rel(file), new Map(info.scopes.map((s) => [s.id, s]))]));
  const pending: [file: string, name: string][] = [];
  const used = new Map<string, Set<string>>();
  const use = (file: string, name: string) => {
    const names = used.get(file) ?? new Set();
    used.set(file, names);
    if (!names.has(name)) names.add(name), pending.push([file, name]);
  };
  const topLevel = (file: string, entry: ScopeEntry) => {
    if (!entry.pure) invalidate(file);
    else for (const name of entry.declares ?? []) use(file, name);
  };

  for (const file of new Set([...Object.keys(previous.scopes), ...current.keys()])) {
    const before = previous.scopes[file] ?? {};
    const after = current.get(file) ?? new Map<string, Scope>();
    for (const id of new Set([...Object.keys(before), ...after.keys()])) {
      const b = before[id];
      const a = after.get(id);
      if (b?.hash === a?.hash) continue;
      if (isTopLevel(id)) {
        if (b) topLevel(file, b);
        if (a) topLevel(file, { hash: a.hash, declares: a.declares ?? [], pure: a.pure ?? false });
      } else if (b && a) {
        if (!recollect(file, id)) invalidate(file);
      } else if (b) {
        // Removed, or renamed by an edit (same-named callbacks are told apart by content).
        recollect(file, id);
      }
    }
  }
  if (pending.length === 0) return { all: false, files: sorted(files, testFiles), stale: sorted(stale, testFiles), impacted: [] };

  // Who imports what from whom: mutated sources (followed by name), and any other local
  // module or test file (invalidated when it imports a used name).
  const importers = new Map<string, { from: string; binding: ImportBinding; reexport: boolean; mutated: boolean }[]>();
  const addImports = (from: string, imports: readonly ImportBinding[], reexport: boolean, mutated: boolean) => {
    for (const binding of imports) {
      const target = resolve(join(root, from), binding.source);
      if (!target) continue;
      const t = rel(target);
      importers.set(t, [...(importers.get(t) ?? []), { from, binding, reexport, mutated }]);
    }
  };
  for (const [file, info] of sources) {
    addImports(rel(file), info.imports, false, true);
    addImports(rel(file), info.reexports, true, true);
  }
  const others = new Set([...Object.keys(testFiles), ...Object.values(previous.deps).flat()].filter((f) => !current.has(f) && SCRIPT.test(f)));
  for (const file of others) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    try {
      const { imports, reexports } = scanImports(path, readFileSync(path, 'utf8'));
      addImports(file, imports, false, false);
      addImports(file, reexports, true, false);
    } catch {
      // Unparsable: whatever it imports is not followed by name, but it is still re-collected through deps.
    }
  }

  while (pending.length > 0) {
    const [file, name] = pending.pop()!;
    for (const scope of current.get(file)?.values() ?? []) {
      if (!scope.refs?.includes(name)) continue;
      if (isTopLevel(scope.id)) {
        topLevel(file, { hash: scope.hash, declares: scope.declares ?? [], pure: scope.pure ?? false });
        continue;
      }
      // The nearest enclosing function with coverage; a nested function runs only once its parent has.
      const segments = scope.id.split('>');
      let found = false;
      for (let n = segments.length; n > 0 && !found; n--) {
        const id = segments.slice(0, n).join('>');
        if (recollect(file, id)) impacted.add(`${join(root, file)}#${id}`), (found = true);
      }
      if (found || !previous.scopes[file]?.[scope.id]) continue; // new functions are reached through edited callers
      if (/^[\w$]+$/.test(scope.id)) use(file, scope.id);
      else invalidate(file);
    }
    for (const { from, binding, reexport, mutated } of importers.get(file) ?? []) {
      if (binding.imported !== '*' && binding.imported !== name) continue;
      if (!mutated) invalidate(from);
      else use(from, reexport && binding.local === '*' ? name : binding.local);
    }
  }
  return { all: false, files: sorted(files, testFiles), stale: sorted(stale, testFiles), impacted: [...impacted].sort() };
}

const sorted = (files: ReadonlySet<string>, testFiles: Readonly<Record<string, string>>) => [...files].filter((f) => f in testFiles).sort();

export type MergedDryRun = Omit<DryRunResult, 'failed'>;

/** Combine a partial dry run with the previous snapshot's data for the test files that were skipped. */
export function mergeDryRun(input: {
  root: string;
  previous: CliSnapshot | undefined;
  dry: DryRunResult;
  /** test files (relative) that were (re)collected */
  dryFiles: ReadonlySet<string>;
  testFiles: Readonly<Record<string, string>>;
  mutants: readonly Mutant[];
}): MergedDryRun {
  const { root, previous, dry, dryFiles, testFiles, mutants } = input;
  const keptModule = (module: string | undefined) => module !== undefined && !dryFiles.has(module) && module in testFiles;

  const tests: TestInfo[] = [...dry.tests];
  const index = new Map<string, TestLocation>(dry.index);
  const dropped: string[] = [];
  for (const test of previous?.tests ?? []) {
    const location = previous?.index[test.id];
    if (location && keptModule(location.module)) {
      tests.push(test);
      index.set(test.id, { moduleId: join(root, location.module), taskId: location.taskId });
    } else {
      dropped.push(test.id);
    }
  }

  const coverage = previous ? mergeCoverage(previous, dry.coverage, dropped, mutants) : new Map(dry.coverage);
  for (const [key, ids] of coverage) if (ids.length === 0) coverage.delete(key);

  const alive = new Set(mutants.map((m) => m.key));
  const staticByFile = new Map(dry.staticByFile);
  for (const [file, keys] of Object.entries(previous?.staticByFile ?? {})) {
    if (keptModule(file)) staticByFile.set(file, new Set(keys.filter((k) => alive.has(k))));
  }
  const staticKeys = new Set([...staticByFile.values()].flatMap((keys) => [...keys]));

  const deps = new Map(dry.deps);
  for (const [file, list] of Object.entries(previous?.deps ?? {})) if (keptModule(file)) deps.set(file, list);

  const hits = new Map(Object.entries(previous?.hits ?? {}).filter(([k]) => alive.has(k)));
  // A partial run only sees some test files: never lower a hit count (and thus a hit limit).
  for (const [key, n] of dry.hits) hits.set(key, Math.max(n, hits.get(key) ?? 0));

  return { tests, coverage, staticKeys, hits, index, staticByFile, deps };
}
