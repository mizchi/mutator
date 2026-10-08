// Decides how much of the coverage (dry) run can be skipped by reusing the previous snapshot.
import { join, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { type Mutant, type RunSnapshot, type TestInfo, hash, mergeCoverage } from '@mizchi/mutator-core';
import type { DryRunResult, TestLocation } from '@mizchi/mutator-vitest';

/** Snapshot persisted by the CLI: the core run snapshot plus adapter-level coverage data. */
export interface CliSnapshot extends RunSnapshot {
  /** test file (relative) -> content hash */
  testFiles: Record<string, string>;
  /** test id -> location (module relative to root) */
  index: Record<string, { module: string; taskId: string }>;
  /** test file (relative) -> mutant keys hit while loading its modules */
  staticByFile: Record<string, string[]>;
  /** test file (relative) -> source files (relative) it executed */
  touched: Record<string, string[]>;
  /** test file (relative) -> non-mutated local files it imports */
  deps: Record<string, string[]>;
  hits: Record<string, number>;
}

/** Content hash of each test file together with the local files it imports. */
export function testFileHashes(root: string, testFiles: readonly string[], deps: Readonly<Record<string, readonly string[]>>): Record<string, string> {
  const read = (rel: string) => {
    const file = join(root, rel);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  return Object.fromEntries(
    testFiles.map((rel) => [rel, hash([read(rel), ...(deps[rel] ?? []).flatMap((dep) => [dep, read(dep)])].join('\0'))]),
  );
}

export type DryRunPlan = { all: true } | { all: false; files: string[] };

const scopeKey = (root: string, file: string, scopeId: string) => `${relative(root, file)}#${scopeId}`;
const isTopLevel = (scopeId: string) => scopeId.startsWith('<top');

export function planDryRun(input: {
  root: string;
  previous: CliSnapshot | undefined;
  /** tool / env of `previous` match the current run */
  valid: boolean;
  testFiles: Readonly<Record<string, string>>;
  mutants: readonly Mutant[];
}): DryRunPlan {
  const { root, previous, testFiles } = input;
  if (!previous || !input.valid) return { all: true };

  const before = new Map<string, string>();
  for (const r of previous.results) before.set(scopeKey(root, r.file, r.scopeId), r.scopeHash);
  const after = new Map<string, string>();
  for (const m of input.mutants) if (!m.ignored) after.set(scopeKey(root, m.file, m.scope.id), m.scope.hash);

  const changedScopes = new Set([...before].filter(([k, h]) => after.get(k) !== h).map(([k]) => k));
  // Code that may run at load time or is new has no per-test coverage to go by:
  // fall back to every test file that touched the source file.
  const sensitiveFiles = new Set<string>();
  for (const k of after.keys()) if (!before.has(k)) sensitiveFiles.add(k.split('#')[0]!);
  for (const k of changedScopes) if (isTopLevel(k.slice(k.indexOf('#') + 1))) sensitiveFiles.add(k.split('#')[0]!);

  const files = new Set<string>();
  for (const [file, hash] of Object.entries(testFiles)) if (previous.testFiles[file] !== hash) files.add(file);
  for (const r of previous.results) {
    if (!changedScopes.has(scopeKey(root, r.file, r.scopeId))) continue;
    for (const test of r.coveredBy) {
      const module = previous.index[test]?.module;
      if (module) files.add(module);
    }
  }
  for (const [testFile, sources] of Object.entries(previous.touched)) {
    if (sources.some((s) => sensitiveFiles.has(s))) files.add(testFile);
  }
  return { all: false, files: [...files].filter((f) => f in testFiles).sort() };
}

export interface MergedDryRun extends Omit<DryRunResult, 'failed'> {
  touched: Record<string, string[]>;
}

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
  for (const [key, n] of dry.hits) hits.set(key, n);

  const fileOf = new Map(mutants.map((m) => [m.key, relative(root, m.file)]));
  const touchedSets = new Map<string, Set<string>>();
  const touch = (testFile: string, key: string) => {
    const source = fileOf.get(key);
    if (!source) return;
    const set = touchedSets.get(testFile) ?? new Set();
    set.add(source);
    touchedSets.set(testFile, set);
  };
  for (const [key, ids] of coverage) for (const id of ids) touch(id.slice(0, id.indexOf('#')), key);
  for (const [file, keys] of staticByFile) for (const key of keys) touch(file, key);
  const touched = Object.fromEntries([...touchedSets].map(([f, s]) => [f, [...s].sort()]));

  return { tests, coverage, staticKeys, hits, index, staticByFile, touched, deps };
}
