import { existsSync, globSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  type CallGraphSource,
  type InstrumentOptions,
  type Mutant,
  type MutantResult,
  type MutantStatus,
  type PlanEntry,
  type Range,
  type RunSnapshot,
  type Scope,
  type SelectMode,
  DEFAULT_ARID_CALLEES,
  buildCallGraph,
  changedLines,
  hash,
  instrument,
  lineRanges,
  parseUnifiedDiff,
  plan,
  relatedScopes,
  selectMutants,
  toResult,
} from '@mizchi/mutator-core';
import { createTypeChecker } from '@mizchi/mutator-typecheck';
import { type PluginSpec, loadPlugins } from './plugins.ts';
import { type Runner, createRunnerSession, detectRunner } from './runner.ts';
import { changedFiles, gitDiff } from './git.ts';
import { type CliSnapshot, type MergedDryRun, mergeDryRun, planDryRun, residualHashes, testFileHashes } from './coverage-cache.ts';
import { oneLine } from './report.ts';
import { readSnapshot, writeSnapshot } from './snapshot.ts';

// Bump whenever mutators or the snapshot format change: new mutants in unchanged
// code have no cached coverage, so old snapshots must not be reused.
export const TOOL_VERSION = '0.0.3';

export interface RunOptions {
  root: string;
  /** Globs (relative to root) of sources to mutate. */
  include?: readonly string[];
  exclude?: readonly string[];
  /** Git ref: only mutants inside `git diff <since>` (plus mutants covered by changed tests) are executed. */
  since?: string;
  scope?: SelectMode;
  snapshotPath?: string;
  /** Test runner (default 'auto': see `detectRunner`). */
  runner?: Runner | 'auto';
  /** Vitest config file. */
  configFile?: string;
  /** Jest config file. */
  jestConfigFile?: string;
  timeoutFactor?: number;
  timeoutMs?: number;
  /**
   * Experimental: only invalidate survivors whose function is connected to a changed
   * function in the static call graph. Faster after edits, but unsound when values
   * flow between functions through test code.
   */
  callGraph?: boolean;
  /**
   * Type-check planned mutants with the project's TypeScript first; those that do not
   * compile become `CompileError` and are not run. `'auto'` (default): when the
   * project has `typescript` and a tsconfig.json.
   */
  typecheck?: boolean | 'auto';
  /** Plugin modules (paths relative to root, package names) or plugin / mutator objects. */
  plugins?: readonly PluginSpec[];
  /** Mutators to skip, built-in or custom, by name. */
  excludedMutators?: readonly string[];
  /** Arid node suppression (logging-only code); `false` disables it. */
  arid?: InstrumentOptions['arid'];
  /** Collect coverage from every test file even when the snapshot could be reused. */
  fullDryRun?: boolean;
  /** Parallel runner sessions running mutants (default: half the CPUs). */
  concurrency?: number;
  log?: (message: string) => void;
}

export interface ReportEntry {
  mutant: Mutant;
  status: MutantStatus;
  /** run: executed now, reuse: taken from the snapshot, skipped: outside --since and no cached result */
  source: 'run' | 'reuse' | 'static' | 'skipped';
  killedBy: string[];
  /** Tests that executed the mutant in the (merged) coverage run. */
  coveredBy: string[];
}

export interface Report {
  entries: ReportEntry[];
  executed: number;
  /** Test files (relative) whose coverage was collected in this run; the rest came from the snapshot. */
  dryRunFiles: string[];
  /** detected / (detected + undetected), ignoring Ignored and Pending */
  score: number;
  durationMs: number;
}

export class BaselineError extends Error {}

const DEFAULT_INCLUDE = ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/*.d.ts', '**/*.{test,spec}.*', '**/__tests__/**'];
const ENV_FILES = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'tsconfig.json'];

/**
 * Vitest reports a worker that dies after its run was abandoned (e.g. a timed-out
 * mutant that keeps allocating until the worker runs out of memory) as an
 * unhandled 'error' event. That run already has a verdict, so it must not abort
 * the whole mutation run; any other uncaught exception stays fatal.
 */
function guardWorkerExits(log: (message: string) => void): () => void {
  const onUncaught = (error: Error) => {
    if (error instanceof Error && error.message.startsWith('Worker exited unexpectedly')) {
      log(`ignored a crashed test worker (likely a mutant exhausting memory): ${error.message}`);
      return;
    }
    process.off('uncaughtException', onUncaught);
    throw error;
  };
  process.on('uncaughtException', onUncaught);
  return () => process.off('uncaughtException', onUncaught);
}

export async function runMutation(options: RunOptions): Promise<Report> {
  const started = performance.now();
  const root = resolve(options.root);
  const log = options.log ?? (() => {});
  const snapshotPath = options.snapshotPath ?? join(root, '.mutator', 'snapshot.json');
  const files = globSync([...(options.include ?? DEFAULT_INCLUDE)], {
    cwd: root,
    exclude: [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])],
  }).map((f) => join(root, f));
  const targets = new Set(files);

  const plugins = await loadPlugins(root, options.plugins ?? []);
  const arid = combineArid(options.arid, plugins.aridCallees);
  const instrumentOptions: InstrumentFlags = {
    ...(arid !== undefined ? { arid } : {}),
    ...(plugins.mutators.length ? { mutators: plugins.mutators } : {}),
    ...(plugins.ignorers.length ? { ignorers: plugins.ignorers } : {}),
    ...(options.excludedMutators?.length ? { excludedMutators: options.excludedMutators } : {}),
  };
  // An explicit runner config picks the runner; otherwise detect it from the project.
  const runner =
    options.runner && options.runner !== 'auto' ? options.runner : options.jestConfigFile ? 'jest' : options.configFile ? 'vitest' : detectRunner(root);
  const configFile = runner === 'jest' ? options.jestConfigFile : options.configFile;
  log(`runner: ${runner}`);
  const sessionOptions = {
    root,
    targets,
    ...instrumentOptions,
    pluginModules: plugins.modules,
    hasPluginObjects: plugins.hasObjects,
    ...(configFile ? { configFile } : {}),
  };
  const session = await createRunnerSession(runner, sessionOptions);
  const sessions = [session];
  const unguard = guardWorkerExits(log);
  try {
    const testFileList = (await session.testFiles()).map((f) => relative(root, f));
    const { mutants, scopes, graphSources } = collectSources(root, files, instrumentOptions);
    const residual = residualHashes(root, scopes, mutants);
    const envFiles = [...ENV_FILES.map((f) => join(root, f)), ...session.configFiles()];
    // Mutation settings change which mutants are placed (and thus covered): part of the environment.
    const settings = JSON.stringify({ runner, arid: arid ?? null, callGraph: options.callGraph ?? false, typecheck: options.typecheck ?? 'auto', plugins: plugins.fingerprint, excluded: options.excludedMutators ?? [] });
    const envHash = hash([process.version, settings, ...[...new Set(envFiles)].sort().flatMap((f) => [relative(root, f), readIfExists(f)])].join('\0'));
    const previous = readSnapshot(snapshotPath, root) as CliSnapshot | undefined;
    const valid = previous !== undefined && previous.toolVersion === TOOL_VERSION && previous.envHash === envHash && previous.index !== undefined;
    // Hash each test file with the helpers it imported last time: editing a helper re-collects the file.
    const testFiles = testFileHashes(root, testFileList, valid ? previous.deps : {}, residual);
    const dryPlan = options.fullDryRun ? ({ all: true } as const) : planDryRun({ root, previous, valid, testFiles, mutants });
    const dryFiles = new Set(dryPlan.all ? Object.keys(testFiles) : dryPlan.files);
    log(`dry run: ${dryFiles.size}/${Object.keys(testFiles).length} test files, ${files.length} source files`);
    const dry = await session.dryRun(dryPlan.all ? undefined : [...dryFiles].map((f) => join(root, f)));
    if (dry.failed.length > 0) throw new BaselineError(`tests fail without mutants: ${dry.failed.join(', ')}`);
    const merged = mergeDryRun({ root, previous: valid ? previous : undefined, dry, dryFiles, testFiles, mutants });
    // Re-hash with the dependencies just observed, and derive test fingerprints from the file hashes.
    const finalTestFiles = testFileHashes(root, testFileList, Object.fromEntries(merged.deps), residual);
    for (const test of merged.tests) {
      const file = test.id.slice(0, test.id.indexOf('#'));
      if (dryFiles.has(file)) test.fingerprint = hash(`${finalTestFiles[file]}\0${test.id}`);
    }
    session.useTestIndex(merged.index);

    const entries = plan({
      mutants,
      tests: merged.tests,
      coverage: merged.coverage,
      staticKeys: merged.staticKeys,
      staticTests: staticTestsOf(merged),
      previous: valid ? previous : undefined,
      toolVersion: TOOL_VERSION,
      envHash,
      ...(options.callGraph ? { related: relatedScopes(buildCallGraph(graphSources, importResolver(files))) } : {}),
      options: { ...(options.timeoutFactor ? { timeoutFactor: options.timeoutFactor } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
    });

    const inScope = options.since ? diffScope(root, options.since, mutants, merged, options.scope ?? 'node') : undefined;
    const report: ReportEntry[] = [];
    const results: MutantResult[] = [];
  
    const jobs: { index: number; entry: Extract<PlanEntry, { kind: 'run' }> }[] = [];
    for (const entry of entries) {
      const { mutant } = entry;
      const coveredBy = [...(merged.coverage.get(mutant.key) ?? [])];
      switch (entry.kind) {
        case 'ignored':
          results.push(toResult(mutant, 'Ignored', [], []));
          report.push({ mutant, status: 'Ignored', source: 'static', killedBy: [], coveredBy });
          break;
        case 'noCoverage':
          results.push(toResult(mutant, 'NoCoverage', [], []));
          report.push({ mutant, status: 'NoCoverage', source: 'static', killedBy: [], coveredBy });
          break;
        case 'reuse':
          // Keep the cached verdict but record today's coverage: new covering tests must not be lost.
          results.push({ ...entry.result, coveredBy });
          report.push({ mutant, status: entry.result.status, source: 'reuse', killedBy: entry.result.killedBy, coveredBy });
          break;
        case 'run':
          if (inScope && !inScope.has(mutant.key)) {
            // Keep the coverage so the next run can still select tests for it.
            results.push(toResult(mutant, 'Pending', [], coveredBy));
            report.push({ mutant, status: 'Pending', source: 'skipped', killedBy: [], coveredBy });
          } else {
            jobs.push({ index: report.length, entry });
            report.push({ mutant, status: 'Pending', source: 'run', killedBy: [], coveredBy });
          }
          break;
      }
    }

    const uncompilable = await typecheckJobs(root, options.typecheck ?? 'auto', jobs.map((j) => j.entry.mutant), log);
    for (let i = jobs.length - 1; i >= 0; i--) {
      const { index, entry } = jobs[i]!;
      const error = uncompilable.get(entry.mutant.key);
      if (error === undefined) continue;
      results.push(toResult(entry.mutant, 'CompileError', [], []));
      report[index] = { mutant: entry.mutant, status: 'CompileError', source: 'static', killedBy: [], coveredBy: merged.coverage.get(entry.mutant.key) ?? [] };
      jobs.splice(i, 1);
    }
    log(`${mutants.length} mutants, ${jobs.length} to run${uncompilable.size ? ` (${uncompilable.size} do not type-check)` : ''}`);
    const concurrency = Math.max(1, Math.min(options.concurrency ?? defaultConcurrency(), jobs.length));
    // In parallel mode every mutant session gets a single worker so sessions do not
    // oversubscribe the CPU; a lone session keeps the runner's default workers.
    const workers = concurrency === 1 ? [session] : await Promise.all(Array.from({ length: concurrency }, () => createRunnerSession(runner, { ...sessionOptions, maxWorkers: 1 })));
    if (concurrency > 1) sessions.push(...workers);
    for (const s of workers) s.useTestIndex(merged.index);
    let executed = 0;
    let next = 0;
    await Promise.all(
      workers.map(async (worker) => {
        while (next < jobs.length) {
          const { index, entry } = jobs[next++]!;
          const { mutant } = entry;
          const outcome = await worker.runMutant(mutant.key, entry.tests, {
            timeoutMs: entry.timeoutMs,
            isStatic: entry.isStatic,
            hitLimit: Math.max(10_000, (merged.hits.get(mutant.key) ?? 0) * 100),
          });
          executed++;
          log(`[${executed}/${jobs.length}] ${outcome.status.padEnd(8)} ${relative(root, mutant.file)}:${mutant.location.start.line} ${oneLine(mutant.original)} -> ${oneLine(mutant.replacement)}`);
          const { coveredBy } = report[index]!;
          results.push(toResult(mutant, outcome.status, outcome.killedBy, coveredBy, outcome.durationMs));
          report[index] = { mutant, status: outcome.status, source: 'run', killedBy: outcome.killedBy, coveredBy };
        }
      }),
    );

    const core = mergeSnapshot(valid ? previous : undefined, { toolVersion: TOOL_VERSION, envHash, results, tests: merged.tests }, mutants);
    const snapshot: CliSnapshot = {
      ...core,
      testFiles: finalTestFiles,
      deps: Object.fromEntries(merged.deps),
      index: Object.fromEntries([...merged.index].map(([id, l]) => [id, { module: relative(root, l.moduleId), taskId: l.taskId }])),
      staticByFile: Object.fromEntries([...merged.staticByFile].map(([f, keys]) => [f, [...keys]])),
      hits: Object.fromEntries(merged.hits),
    };
    writeSnapshot(snapshotPath, snapshot, root);
    return { entries: report, executed, dryRunFiles: [...dryFiles].sort(), score: score(report), durationMs: performance.now() - started };
  } finally {
    await Promise.all(sessions.map((s) => s.close()));
    unguard();
  }
}

function defaultConcurrency(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

const TS_FILE = /\.(c|m)?tsx?$/;

/** Mutant key -> first new type error, for mutants of TypeScript files that do not compile. */
async function typecheckJobs(root: string, setting: boolean | 'auto', mutants: readonly Mutant[], log: (message: string) => void): Promise<Map<string, string>> {
  const candidates = mutants.filter((m) => TS_FILE.test(m.file));
  if (setting === false || candidates.length === 0) return new Map();
  const checker = await createTypeChecker({ root });
  if (!checker) {
    if (setting === true) throw new Error('typecheck: no typescript package or tsconfig.json found in the project');
    return new Map();
  }
  try {
    const started = performance.now();
    const result = checker.check(candidates);
    log(`typecheck (TypeScript ${checker.version}): ${candidates.length} mutants in ${((performance.now() - started) / 1000).toFixed(1)}s`);
    return result;
  } finally {
    checker.close();
  }
}

/** Plugins' logging patterns extend the arid callees (the defaults, or the configured ones). */
function combineArid(arid: InstrumentOptions['arid'], extra: readonly string[]): InstrumentOptions['arid'] {
  if (arid === false || extra.length === 0) return arid;
  return { callees: [...(arid?.callees ?? DEFAULT_ARID_CALLEES), ...extra] };
}

/** Static mutant key -> tests of the test files whose module loading executed it. */
function staticTestsOf(merged: MergedDryRun): Map<string, string[]> {
  const testsByFile = new Map<string, string[]>();
  for (const t of merged.tests) {
    const file = t.id.slice(0, t.id.indexOf('#'));
    testsByFile.set(file, [...(testsByFile.get(file) ?? []), t.id]);
  }
  const out = new Map<string, string[]>();
  for (const [file, keys] of merged.staticByFile) {
    for (const key of keys) out.set(key, [...(out.get(key) ?? []), ...(testsByFile.get(file) ?? [])]);
  }
  return out;
}

/** Mutants and scopes of every target file; keys match the ones the Vite plugin produces. */
type InstrumentFlags = Pick<InstrumentOptions, 'arid' | 'mutators' | 'ignorers' | 'excludedMutators'>;

function collectSources(root: string, files: readonly string[], instrumentOptions: InstrumentFlags) {
  const scopes = new Map<string, Scope[]>();
  const graphSources: CallGraphSource[] = [];
  const mutants = files.flatMap((file) => {
    const result = instrument(file, readFileSync(file, 'utf8'), { identity: relative(root, file), ...instrumentOptions });
    scopes.set(file, result.scopes);
    graphSources.push({ file, scopes: result.scopes, calls: result.calls, imports: result.imports });
    return result.mutants;
  });
  return { mutants, scopes, graphSources };
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '/index.ts', '/index.js'];

/** Relative import specifier -> one of the mutated files (TS-style `.js` -> `.ts` included). */
function importResolver(files: readonly string[]) {
  const known = new Set(files);
  return (from: string, specifier: string): string | undefined => {
    if (!specifier.startsWith('.')) return undefined;
    const base = join(dirname(from), specifier);
    const stems = [base, base.replace(/\.(c|m)?js$/, '.$1ts').replace(/\.jsx$/, '.tsx')];
    for (const stem of stems) for (const suffix of RESOLVE_SUFFIXES) if (known.has(stem + suffix)) return stem + suffix;
    return undefined;
  };
}

/** Mutants touched by the diff, plus mutants covered by tests in changed test files. */
function diffScope(root: string, since: string, mutants: readonly Mutant[], dry: { coverage: ReadonlyMap<string, readonly string[]> }, mode: SelectMode): Set<string> {
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
  const selected = new Set(selectMutants(mutants, changed, mode).map((m) => m.key));
  const changedTestFiles = [...changed.keys()].map((f) => f.slice(root.length + 1));
  for (const [key, tests] of dry.coverage) {
    if (tests.some((t) => changedTestFiles.some((f) => t.startsWith(`${f}#`)))) selected.add(key);
  }
  return selected;
}

/** Keep cached results of mutants that still exist but were not part of this run. */
function mergeSnapshot(previous: RunSnapshot | undefined, current: RunSnapshot, mutants: readonly Mutant[]): RunSnapshot {
  if (!previous || previous.toolVersion !== current.toolVersion || previous.envHash !== current.envHash) return current;
  const written = new Set(current.results.map((r) => r.key));
  const alive = new Map(mutants.map((m) => [m.key, m.scope.hash]));
  const kept = previous.results.filter((r) => !written.has(r.key) && alive.get(r.key) === r.scopeHash);
  return { ...current, results: [...current.results, ...kept] };
}

const DETECTED = new Set<string>(['Killed', 'Timeout', 'RuntimeError']);
const UNDETECTED = new Set<string>(['Survived', 'NoCoverage']);

function score(entries: readonly ReportEntry[]): number {
  const detected = entries.filter((e) => DETECTED.has(e.status)).length;
  const undetected = entries.filter((e) => UNDETECTED.has(e.status)).length;
  return detected + undetected === 0 ? 1 : detected / (detected + undetected);
}

function readIfExists(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}
