import { existsSync } from 'node:fs';
import { delimiter, join, relative, resolve } from 'node:path';
import {
  type InstrumentOptions,
  type Mutant,
  type MutantStatus,
  type ResultReason,
  type SelectMode,
  type TestInfo,
  buildCallGraph,
  plan,
  relatedScopes,
  selectPerLine,
  testFileOf,
  testFingerprint,
} from '@mizchi/mutator-core';
import { applyAcceptance } from './accepted.ts';
import { type SpawningTest, childProcessReach, possiblyInChildProcess } from './child-process.ts';
import { type CliSnapshot, type MergedDryRun, mergeDryRun, planDryRun, testFileHashes } from './coverage-cache.ts';
import { executeJobs } from './execute.ts';
import { type KillMatrixAnalysis, analyzeKillMatrix } from './kill-matrix.ts';
import type { PluginSpec } from './plugins.ts';
import { ENV_FILES, SNAPSHOT_VERSION, buildSnapshot, environmentHash, mutationSettings } from './reuse.ts';
import { type Runner, createRunnerSession } from './runner.ts';
import { collectSources, importResolver, resolveSetup } from './setup.ts';
import { diffLines, diffTouched, sinceFocus, skippedInDiff, uncollectedTests } from './since.ts';
import { readSnapshot, writeSnapshot } from './snapshot.ts';
import { score } from './status.ts';
import { applyTypecheck, classifyPlan } from './tally.ts';
import type { TimeoutRetries } from './timeout-retry.ts';
import { type EarlyTypecheck, TS_FILE, startTypecheck, typecheckJobs } from './typecheck.ts';

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
  /** Playwright config file. */
  playwrightConfigFile?: string;
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
  /**
   * Weak mutation (default true): the dry run records which tests reach a mutant with a
   * different value; covered mutants no test infects are decided Survived without running.
   */
  weakMutation?: boolean;
  /** Mutant key -> reason: undetected mutants judged equivalent; reported `Ignored` (the cache keeps the verdict). */
  accepted?: ReadonlyMap<string, string>;
  /** Run and report only these mutant keys (within --since, if given), e.g. to re-check survivors after adding a test. */
  only?: ReadonlySet<string>;
  /** Arid node suppression (logging-only code); `false` disables it. */
  arid?: InstrumentOptions['arid'];
  /** Collect coverage from every test file even when the snapshot could be reused. */
  fullDryRun?: boolean;
  /** Parallel runner sessions running mutants (default: half the CPUs). */
  concurrency?: number;
  /** Run at most this many mutants per source line (see `selectPerLine`); the rest are Pending. */
  mutantsPerLine?: number;
  /** Seconds from the start of the run after which no new mutant run starts; the rest are Pending. */
  timeBudget?: number;
  /**
   * Measure the kill matrix: mutants run every covering test without early exit, so `killedBy`
   * lists every test that fails; the report then lists tests that detect nothing or are subsumed.
   */
  killMatrix?: boolean;
  log?: (message: string) => void;
}

export interface ReportEntry {
  mutant: Mutant;
  status: MutantStatus;
  /**
   * run: executed now, reuse: taken from the snapshot, skipped: needed a run but was not
   * run (outside --since, sampled out by mutantsPerLine, or over the time budget).
   */
  source: 'run' | 'reuse' | 'static' | 'skipped';
  killedBy: string[];
  /** Tests that executed the mutant in the (merged) coverage run. */
  coveredBy: string[];
  /**
   * With --since: `diff` for a mutant inside the diff, `recheck` for one outside it that was
   * killed before but whose killing tests are all gone. Other entries are context, not reported.
   */
  focus?: 'diff' | 'recheck';
  /**
   * Decided without running. `notInfected`: Survived, no covering test reaches it with a value
   * it changes. `equivalent: ...`: Ignored, proven equivalent by types.
   */
  reason?: ResultReason;
  /** Undetected but accepted (mutator.accepted.json), with the recorded reason; the status is then `Ignored`. */
  accepted?: string;
  /** Killed without early exit (--kill-matrix): `killedBy` lists every covering test that fails. */
  matrix?: true;
}

export interface Report {
  entries: ReportEntry[];
  executed: number;
  /** Test files (relative) whose coverage was collected in this run; the rest came from the snapshot. */
  dryRunFiles: string[];
  /** detected / (detected + undetected), ignoring Ignored and Pending */
  score: number;
  /** `diff`: with --since the score covers only mutants inside the diff (`focus: 'diff'`). */
  scope: 'all' | 'diff';
  durationMs: number;
  /**
   * Runs (or shards) that ran out of time and were re-run once with a longer budget;
   * `confirmed`: those that timed out again. Absent when none was re-run.
   */
  timeoutRetries?: TimeoutRetries;
  /** RuntimeErrors re-run to confirm them; `confirmed`: failed the same way again. */
  runtimeErrorRetries?: TimeoutRetries;
  /** Mutants that needed a run but were left Pending: sampled out (mutantsPerLine) or over the time budget. */
  notRun: { sampled: number; budget: number };
  /** With --since: changed test files (relative) the runner does not collect. */
  uncollectedTests?: string[];
  /** Tests ran, yet no mutant was reached: the instrumentation or `include` is likely wrong, not the tests. */
  noCoverage?: true;
  /** With --since: skipped or todo tests on the changed lines of test files (they check nothing). */
  skippedTests?: { file: string; line: number; text: string }[];
  /** With accepted mutants: those detected now (their entry can go), and entries whose mutant no longer exists. */
  acceptance?: { killed: string[]; stale: string[] };
  /** `only`: the reported mutants were selected with `only` (`scope` is then `diff`). */
  selection?: 'only';
  /** `only` keys that match no mutant (a typo, or code that changed). */
  unknownKeys?: string[];
  /** Tests whose child process runs a project file (spawned in the dry run), with the command. */
  childProcessTests?: SpawningTest[];
  /** Undetected mutants in files those child processes may load: possibly reached there, not counted by --fail-on-survived. */
  childProcessMutants?: string[];
  /** Mutants in critical regions (config globs or `// mutator-critical`): each must be killed or accepted. Set by the CLI. */
  criticalMutants?: string[];
  /** With --kill-matrix: tests that kill nothing or are subsumed, over the mutants with a full matrix. */
  killMatrix?: KillMatrixAnalysis;
}

export class BaselineError extends Error {}


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

/**
 * Tests may spawn the project's CLIs by name (as `npm run` / `npx` allow); make
 * `<root>/node_modules/.bin` visible like those launchers do. Returns a restore function.
 */
export function exposeProjectBin(root: string, env: NodeJS.ProcessEnv = process.env): () => void {
  const bin = join(root, 'node_modules', '.bin');
  const original = env.PATH;
  const entries = (original ?? '').split(delimiter);
  if (!existsSync(bin) || entries.includes(bin)) return () => {};
  env.PATH = [bin, ...entries.filter(Boolean)].join(delimiter);
  return () => {
    if (original === undefined) delete env.PATH;
    else env.PATH = original;
  };
}

export async function runMutation(options: RunOptions): Promise<Report> {
  const started = performance.now();
  const root = resolve(options.root);
  const log = options.log ?? (() => {});
  const snapshotPath = options.snapshotPath ?? join(root, '.mutator', 'snapshot.json');
  const { files, plugins, arid, instrumentOptions, runner, sessionOptions } = await resolveSetup(root, options, log);
  const session = await createRunnerSession(runner, sessionOptions);
  const sessions = [session];
  const unguard = guardWorkerExits(log);
  const restorePath = exposeProjectBin(root);
  let early: EarlyTypecheck | undefined;
  try {
    const testFileList = (await session.testFiles()).map((f) => relative(root, f));
    const { mutants, sources, graphSources } = collectSources(root, files, instrumentOptions);
    const mutated = new Set(files.map((f) => relative(root, f)));
    const envFiles = [...new Set([...ENV_FILES, ...session.configFiles().map((f) => relative(root, f))])].sort();
    const envHash = environmentHash(root, mutationSettings(options, { runner, arid, plugins }), envFiles);
    const previous = readSnapshot(snapshotPath, root) as CliSnapshot | undefined;
    const valid = previous !== undefined && previous.toolVersion === SNAPSHOT_VERSION && previous.envHash === envHash && previous.index !== undefined;
    // The previous snapshot when it can be reused; every consumer below goes through this.
    const reusable = valid ? previous : undefined;
    // Hash each test file with the helpers it imported last time: editing a helper re-collects the file.
    const testFiles = testFileHashes(root, testFileList, reusable?.deps ?? {}, mutated);
    const dryPlan = options.fullDryRun ? ({ all: true } as const) : planDryRun({ root, previous, valid, testFiles, sources, resolve: importResolver(files) });
    const dryFiles = new Set(dryPlan.all ? Object.keys(testFiles) : dryPlan.files);
    log(`dry run: ${dryFiles.size}/${Object.keys(testFiles).length} test files, ${files.length} source files`);
    // Mutants inside the diff need a type check whatever the dry run finds: start it now,
    // off this thread, so it overlaps the dry run.
    const lines = options.since ? diffLines(root, options.since) : undefined;
    const touched = lines && diffTouched(root, lines, mutants, options.scope ?? 'node');
    const uncollected = lines && uncollectedTests([...lines.keys()], new Set(testFileList), (f) => session.excludesTestFile?.(join(root, f)) ?? false);
    const skipped = lines && skippedInDiff(root, lines);
    // Sampled over every mutant, not only those needing a run: the choice must not depend on the cache.
    const sampled = options.mutantsPerLine !== undefined ? selectPerLine(mutants, options.mutantsPerLine) : undefined;
    early = touched && options.typecheck !== false ? startTypecheck(root, mutants.filter((m) => m.ignored === undefined && TS_FILE.test(m.file) && touched.has(m.key) && (!sampled || sampled.has(m.key)))) : undefined;
    const dryStarted = performance.now();
    const dry = await session.dryRun(dryPlan.all ? undefined : [...dryFiles].map((f) => join(root, f)));
    if (dryFiles.size > 0) log(`dry run finished in ${((performance.now() - dryStarted) / 1000).toFixed(1)}s`);
    if (dry.failed.length > 0) throw new BaselineError(`tests fail without mutants: ${dry.failed.join(', ')}`);
    const merged = mergeDryRun({ root, previous: reusable, dry, dryFiles, testFiles, mutants });
    // Re-hash with the dependencies just observed, and derive test fingerprints from the file hashes.
    const finalTestFiles = testFileHashes(root, testFileList, Object.fromEntries(merged.deps), mutated);
    for (const test of merged.tests) {
      const file = testFileOf(test.id);
      if (dryFiles.has(file)) test.fingerprint = testFingerprint(finalTestFiles[file]!, test.id);
    }
    session.useTestIndex(merged.index);

    const entries = plan({
      mutants,
      tests: merged.tests,
      coverage: merged.coverage,
      staticKeys: merged.staticKeys,
      staticTests: staticTestsOf(merged),
      // Infection is known only for the tests this dry run executed.
      ...(dry.infected ? { infection: { infected: dry.infected, observed: new Set(dry.tests.map((t) => t.id)) } } : {}),
      previous: reusable,
      toolVersion: SNAPSHOT_VERSION,
      envHash,
      ...(options.callGraph ? { related: relatedScopes(buildCallGraph(graphSources, importResolver(files))) } : {}),
      ...(dryPlan.all ? {} : { affected: { tests: testsOf(merged.tests, new Set(dryPlan.stale)), scopes: new Set(dryPlan.impacted) } }),
      options: { ...(options.timeoutFactor ? { timeoutFactor: options.timeoutFactor } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
      ...(options.killMatrix ? { killMatrix: true } : {}),
    });

    const since = touched ? sinceFocus(touched, reusable?.results ?? [], merged.tests) : undefined;
    const unknownKeys = options.only ? [...options.only].filter((k) => !mutants.some((m) => m.key === k)) : [];
    const inScope = options.only ? selectOnly(options.only, since, mutants) : since;
    const { tally, jobs, notInfected } = classifyPlan(entries, merged.coverage, inScope, sampled);
    const { report, results, notRun } = tally;
    const typecheck = await typecheckJobs(root, options.typecheck ?? 'auto', [...jobs.map((j) => j.entry.mutant), ...notInfected.map((i) => report[i]!.mutant)], log, early);
    applyTypecheck(tally, jobs, notInfected, typecheck);
    const decided = [...(typecheck.errors.size ? [`${typecheck.errors.size} do not type-check`] : []), ...(typecheck.equivalent.size ? [`${typecheck.equivalent.size} equivalent by types`] : [])];
    log(`${mutants.length} mutants, ${jobs.length} to run${decided.length ? ` (${decided.join(', ')})` : ''}`);
    const { executed, timeoutRetries, runtimeErrorRetries } = await executeJobs(jobs, tally, { root, log, runner, sessionOptions, session, sessions, merged, started, timeBudget: options.timeBudget, concurrency: options.concurrency, killMatrix: options.killMatrix ?? false });

    const snapshot = buildSnapshot(root, reusable, { envHash, envFiles, results, mutants, merged, testFiles: finalTestFiles, sources });
    writeSnapshot(snapshotPath, snapshot, root);
    if (inScope) {
      for (const e of report) {
        const focus = inScope.get(e.mutant.key);
        if (focus) e.focus = focus;
      }
    }
    const acceptance = options.accepted?.size ? applyAcceptance(report, options.accepted) : undefined;
    const final = acceptance?.entries ?? report;
    const scored = inScope ? final.filter((e) => e.focus === 'diff') : final;
    const spawned = childProcessReach({ root, spawns: merged.spawns, resolve: importResolver(files, true) });
    // Coverage, not verdicts: a reached mutant may still be pending (time budget). The merged
    // coverage holds only mutants some test reached.
    const reached = merged.staticKeys.size > 0 || merged.coverage.size > 0;
    const noCoverage = merged.tests.length > 0 && mutants.length > 0 && !reached;
    return {
      entries: final,
      executed,
      dryRunFiles: [...dryFiles].sort(),
      score: score(scored),
      scope: inScope ? 'diff' : 'all',
      durationMs: performance.now() - started,
      notRun,
      ...(timeoutRetries.retried ? { timeoutRetries } : {}),
      ...(runtimeErrorRetries.retried ? { runtimeErrorRetries } : {}),
      ...(options.only ? { selection: 'only' as const } : {}),
      ...(unknownKeys.length ? { unknownKeys } : {}),
      ...(uncollected ? { uncollectedTests: uncollected } : {}),
      ...(noCoverage ? { noCoverage: true as const } : {}),
      ...(skipped?.length ? { skippedTests: skipped } : {}),
      ...(acceptance ? { acceptance: { killed: acceptance.killed, stale: acceptance.stale } } : {}),
      ...(spawned.tests.length ? { childProcessTests: spawned.tests, childProcessMutants: possiblyInChildProcess(final, spawned.files, root) } : {}),
      // Before acceptance: an accepted survivor still shows which tests kill nothing.
      ...(options.killMatrix ? { killMatrix: analyzeKillMatrix(report.map((e) => ({ ...e, key: e.mutant.key }))) } : {}),
    };
  } finally {
    early?.cancel();
    await Promise.all(sessions.map((s) => s.close()));
    unguard();
    restorePath();
  }
}

/** The `only` keys as a focus map, kept within the --since focus when there is one. */
function selectOnly(only: ReadonlySet<string>, since: ReadonlyMap<string, 'diff' | 'recheck'> | undefined, mutants: readonly Mutant[]): Map<string, 'diff' | 'recheck'> {
  const known = new Set(mutants.map((m) => m.key));
  const out = new Map<string, 'diff' | 'recheck'>();
  for (const key of only) {
    if (!known.has(key)) continue;
    if (!since) out.set(key, 'diff');
    else if (since.has(key)) out.set(key, since.get(key)!);
  }
  return out;
}

const testsOf = (tests: readonly TestInfo[], files: ReadonlySet<string>) => new Set(tests.map((t) => t.id).filter((id) => files.has(testFileOf(id))));

/** Static mutant key -> tests of the test files whose module loading executed it. */
function staticTestsOf(merged: MergedDryRun): Map<string, string[]> {
  const testsByFile = new Map<string, string[]>();
  for (const t of merged.tests) {
    const file = testFileOf(t.id);
    testsByFile.set(file, [...(testsByFile.get(file) ?? []), t.id]);
  }
  const out = new Map<string, string[]>();
  for (const [file, keys] of merged.staticByFile) {
    for (const key of keys) out.set(key, [...(out.get(key) ?? []), ...(testsByFile.get(file) ?? [])]);
  }
  return out;
}

/** Every mutant of the target files, without running anything (e.g. to check keys given to `mutator accept`). */
export async function listMutants(options: RunOptions): Promise<Mutant[]> {
  const root = resolve(options.root);
  const { files, instrumentOptions } = await resolveSetup(root, options, options.log ?? (() => {}));
  return collectSources(root, files, instrumentOptions).mutants;
}
