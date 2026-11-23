// Decides how much of the coverage (dry) run can be skipped by reusing the previous snapshot.
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import {
  type DryRunResult,
  type Mutant,
  type MutantResult,
  type RunSnapshot,
  type Scope,
  type SpawnedCommand,
  type TestInfo,
  type TestLocation,
  hash,
  isTopLevelScope,
  mergeCoverage,
  relativePath as relative,
} from '@mizchi/mutator-core';
import { type SourceInfo, followNames, importGraph, loadersOf } from './consumers.ts';

export type { SourceInfo } from './consumers.ts';

/** Snapshot persisted by the CLI: the core run snapshot plus adapter-level coverage data. */
export interface CliSnapshot extends RunSnapshot {
  typecheck?: import('./typecheck-cache.ts').TypecheckCache;
  testReview?: import('./test-impact.ts').TestReview;
  /** Files (relative) whose content `envHash` covers: lockfiles, tsconfig, the runner's config and setup files. */
  envFiles?: string[];
  /** test file (relative) -> content hash */
  testFiles: Record<string, string>;
  /** test id -> location (module relative to root) */
  index: Record<string, { module: string; taskId: string; projectName?: string }>;
  /** test file (relative) -> mutant keys hit while loading its modules */
  staticByFile: Record<string, string[]>;
  /** test file (relative) -> local files it imports, including mutated sources */
  deps: Record<string, string[]>;
  hits: Record<string, number>;
  /** test id -> processes it started in the dry run */
  spawns?: Record<string, SpawnedCommand[]>;
  /** test file (relative) -> files and directories (relative) it read through `node:fs` in the dry run */
  reads?: Record<string, string[]>;
  /** test file (relative) -> environment variables it read in the dry run; `*` when it listed them all */
  env?: Record<string, string[]>;
  /** source file (relative) -> scope id -> entry */
  scopes?: Record<string, Record<string, ScopeEntry>>;
  /** Source file (relative) -> static module requests in evaluation order. */
  moduleLoads?: Record<string, readonly string[]>;
  /** Original source scope (`relative file#scopeId`) -> tests that executed it. */
  sourceCoverage?: Record<string, string[]>;
  sourceCoverageIncomplete?: string[];
}

/** A scope as recorded in the snapshot; top-level statements keep what they declare. */
export interface ScopeEntry {
  hash: string;
  declares?: string[];
  pure?: boolean;
  initializationHash?: string;
}

export function scopeTable(root: string, sources: ReadonlyMap<string, SourceInfo>): Record<string, Record<string, ScopeEntry>> {
  return Object.fromEntries(
    [...sources].map(([file, { scopes }]) => [
      relative(root, file),
      Object.fromEntries(scopes.map(({ id, hash, declares, pure, initializationHash }) => [
        id, declares ? { hash, declares, pure: pure ?? false, ...(initializationHash ? { initializationHash } : {}) } : { hash },
      ])),
    ]),
  );
}

const sameOrder = (before: readonly string[], after: readonly string[]) => before.length === after.length && before.every((item, i) => item === after[i]);

function initializationOrder(scopes: Iterable<ScopeEntry>): string[] {
  const order: string[] = [];
  for (const { initializationHash, declares } of scopes) {
    if (initializationHash === undefined) continue;
    order.push(initializationHash);
    // A binding still identifies its position when its initializer is edited or its declaration is split.
    for (const name of declares ?? []) order.push(`binding:${name}`);
  }
  return order;
}

/** Compare the relative order of statements and bindings present in both versions. */
function statementsReordered(before: Iterable<ScopeEntry>, after: Iterable<ScopeEntry>): boolean {
  const oldOrder = initializationOrder(before);
  const newOrder = initializationOrder(after);
  if (sameOrder(oldOrder, newOrder)) return false;
  const oldItems = new Set(oldOrder);
  const newItems = new Set(newOrder);
  return !sameOrder(oldOrder.filter((item) => newItems.has(item)), newOrder.filter((item) => oldItems.has(item)));
}

export interface TestInputs {
  /** test file (relative) -> files and directories (relative) it read through `node:fs` */
  reads?: Readonly<Record<string, readonly string[]>>;
  /** test file (relative) -> environment variables it read; `*` when it listed them all */
  env?: Readonly<Record<string, readonly string[]>>;
  /** Values of the variables; defaults to this process's environment, which the test workers inherit. */
  environment?: NodeJS.ProcessEnv;
}

/**
 * Content hash of each test file together with the local files it imports, and the files and
 * environment variables it read while it ran (the snapshot of an unchanged input reuses its verdicts).
 * Mutated sources are left out: the dry-run planner follows their edits per scope.
 */
export function testFileHashes(
  root: string,
  testFiles: readonly string[],
  deps: Readonly<Record<string, readonly string[]>>,
  mutated: ReadonlySet<string>,
  /** What each test file read at run time: files and directories (relative), and environment variables. */
  inputs: TestInputs = {},
): Record<string, string> {
  const read = (rel: string) => {
    const file = join(root, rel);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const content = (rel: string) => (mutated.has(rel) ? '' : read(rel));
  const environment = inputs.environment ?? process.env;
  return Object.fromEntries(testFiles.map((rel) => {
    const parts = [read(rel), ...(deps[rel] ?? []).flatMap((dep) => [dep, content(dep)])];
    const reads = inputs.reads?.[rel] ?? [];
    if (reads.length) parts.push('\0reads', ...reads.flatMap((file) => [file, inputContent(join(root, file))]));
    const names = inputs.env?.[rel] ?? [];
    if (names.length) parts.push('\0env', ...names.flatMap((name) => [name, name === '*' ? wholeEnvironment(environment) : envValue(environment[name])]));
    return [rel, hash(parts.join('\0'))];
  }));
}

/** What a test sees of a path it read: a file's content, a directory's entries, or that it is missing. */
function inputContent(file: string): string {
  try {
    if (statSync(file).isDirectory()) return `\0dir\0${readdirSync(file).sort().join('\0')}`;
    return readFileSync(file, 'utf8');
  } catch {
    return '\0missing';
  }
}

const envValue = (value: string | undefined) => (value === undefined ? '\0unset' : value);

/**
 * Variables that differ between shells and terminals of the same machine, left out of the
 * key of a test that listed every variable: keying on them would re-collect it on every run.
 */
const VOLATILE_ENV = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL', 'COLUMNS', 'LINES', 'WINDOWID', 'TERM_SESSION_ID', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'SECURITYSESSIONID', 'LaunchInstanceID']);
const VOLATILE_ENV_PREFIX = /^(?:npm_|SSH_|TMUX|ITERM_|VSCODE_|KITTY_|WEZTERM_|GHOSTTY_|XPC_|__CF|Apple_PubSub|VITEST_)/;

function wholeEnvironment(environment: NodeJS.ProcessEnv): string {
  return Object.keys(environment)
    .filter((name) => !VOLATILE_ENV.has(name) && !VOLATILE_ENV_PREFIX.test(name))
    .sort()
    .map((name) => `${name}=${environment[name]}`)
    .join('\0');
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
      /** Source coverage sees changed functions that mutant results cannot see. */
      affectedTests?: string[];
    };

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
  const affectedTests = new Set<string>();
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
    const observed = previous.sourceCoverage?.[`${file}#${scopeId}`];
    if (!results && !observed?.length) return false;
    for (const id of observed ?? []) {
      const module = previous.index[id]?.module;
      if (module) { files.add(module); affectedTests.add(id); }
    }
    for (const id of previous.sourceCoverageIncomplete ?? []) {
      const module = previous.index[id]?.module;
      if (module && previous.deps[module]?.includes(file)) { files.add(module); affectedTests.add(id); }
    }
    for (const r of results ?? []) {
      for (const t of r.coveredBy) {
        const module = previous.index[t]?.module;
        if (module) files.add(module);
      }
      for (const f of staticFilesByKey.get(r.key) ?? []) files.add(f);
    }
    return true;
  };
  /** Every test file importing `file` (directly or not) re-collects, and its results are stale. */
  const invalidate = (file: string) => {
    const loaders = loadersOf(file, previous.deps, testFiles);
    const candidates = previous.sourceCoverage && loaders.length === 0 ? Object.keys(testFiles) : loaders;
    for (const t of candidates) files.add(t), stale.add(t);
  };

  const current = new Map([...sources].map(([file, info]) => [rel(file), new Map(info.scopes.map((s) => [s.id, s]))]));
  const seeds: [file: string, name: string][] = [];
  const topLevel = (file: string, entry: ScopeEntry) => {
    if (!entry.pure) invalidate(file);
    else for (const name of entry.declares ?? []) seeds.push([file, name]);
  };

  for (const file of new Set([...Object.keys(previous.scopes), ...current.keys()])) {
    if (previous.sourceCoverage && !Object.hasOwn(previous.scopes, file) && current.has(file)) {
      // A new module can join an E2E route through glob imports or a registry;
      // historical coverage and deps cannot prove which test will load it.
      invalidate(file);
      continue;
    }
    const before = previous.scopes[file] ?? {};
    const after = current.get(file) ?? new Map<string, Scope>();
    const oldLoads = previous.moduleLoads?.[file] ?? [];
    const newLoads = sources.get(join(root, file))?.loads ?? [];
    if (!sameOrder(oldLoads, newLoads) || statementsReordered(Object.values(before), after.values())) invalidate(file);
    for (const id of new Set([...Object.keys(before), ...after.keys()])) {
      const b = before[id];
      const a = after.get(id);
      if (b?.hash === a?.hash) {
        // The scope hash omits callback bodies, but a module-level call can observe them at load time.
        if (a?.pure === false && b?.initializationHash !== a.initializationHash) invalidate(file);
        continue;
      }
      if (isTopLevelScope(id)) {
        if (b) topLevel(file, b);
        if (a) topLevel(file, { hash: a.hash, declares: a.declares ?? [], pure: a.pure ?? false });
      } else if (b && a) {
        if (!recollect(file, id)) invalidate(file);
      } else if (b) {
        // Removed, or renamed by an edit (same-named callbacks are told apart by content).
        if (!recollect(file, id)) invalidate(file);
      } else if (a && previous.sourceCoverage) {
        invalidate(file);
      }
    }
  }
  if (seeds.length === 0) return { all: false, files: sorted(files, testFiles), stale: sorted(stale, testFiles), impacted: [], ...(affectedTests.size ? { affectedTests: [...affectedTests].sort() } : {}) };

  const invalidated = followNames({
    scopes: current,
    importers: importGraph({ root, sources, others: [...Object.keys(testFiles), ...Object.values(previous.deps).flat()], resolve }),
    seeds,
    reach: (file, id) => recollect(file, id) && (impacted.add(`${join(root, file)}#${id}`), true),
    // New functions are reached through edited callers.
    skip: (file, id) => !previous.scopes![file]?.[id],
  });
  for (const file of invalidated) invalidate(file);
  return { all: false, files: sorted(files, testFiles), stale: sorted(stale, testFiles), impacted: [...impacted].sort(), ...(affectedTests.size ? { affectedTests: [...affectedTests].sort() } : {}) };
}

const sorted = (files: ReadonlySet<string>, testFiles: Readonly<Record<string, string>>) => [...files].filter((f) => f in testFiles).sort();

export type MergedDryRun = Omit<DryRunResult, 'failed' | 'failures' | 'spawns' | 'reads' | 'env'> & {
  spawns: Map<string, SpawnedCommand[]>;
  reads: Map<string, string[]>;
  env: Map<string, string[]>;
};

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
      index.set(test.id, { moduleId: join(root, location.module), taskId: location.taskId, ...(location.projectName === undefined ? {} : { projectName: location.projectName }) });
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
  // Re-collected test files keep only what they read this time.
  const keptFiles = (current: ReadonlyMap<string, string[]> | undefined, before: Record<string, string[]> | undefined) => {
    const merged = new Map([...(current ?? [])].filter(([file]) => dryFiles.has(file)));
    for (const [file, list] of Object.entries(before ?? {})) if (keptModule(file)) merged.set(file, list);
    return merged;
  };
  const reads = keptFiles(dry.reads, previous?.reads);
  const env = keptFiles(dry.env, previous?.env);

  const hits = new Map(Object.entries(previous?.hits ?? {}).filter(([k]) => alive.has(k)));
  // A partial run only sees some test files: never lower a hit count (and thus a hit limit).
  for (const [key, n] of dry.hits) hits.set(key, Math.max(n, hits.get(key) ?? 0));

  const spawns = new Map(dry.spawns);
  for (const [id, list] of Object.entries(previous?.spawns ?? {})) if (keptModule(previous?.index[id]?.module)) spawns.set(id, list);

  const sourceCoverage = previous?.sourceCoverage || dry.sourceCoverage ? new Map<string, string[]>() : undefined;
  const sourceCoverageIncomplete = sourceCoverage ? new Set(dry.sourceCoverageIncomplete) : undefined;
  if (sourceCoverage) {
    for (const [scope, ids] of Object.entries(previous?.sourceCoverage ?? {})) {
      const kept = ids.filter((id) => keptModule(previous?.index[id]?.module));
      if (kept.length) sourceCoverage.set(scope, kept);
    }
    for (const [scope, ids] of dry.sourceCoverage ?? []) sourceCoverage.set(scope, [...new Set([...(sourceCoverage.get(scope) ?? []), ...ids])]);
    for (const id of previous?.sourceCoverageIncomplete ?? []) if (keptModule(previous?.index[id]?.module)) sourceCoverageIncomplete!.add(id);
    if (!dry.sourceCoverage) for (const test of dry.tests) sourceCoverageIncomplete!.add(test.id);
  }
  return { tests, coverage, staticKeys, hits, index, staticByFile, deps, spawns, reads, env, ...(sourceCoverage ? { sourceCoverage, sourceCoverageIncomplete: sourceCoverageIncomplete! } : {}) };
}
