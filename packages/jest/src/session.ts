// Jest session: every dry run and every mutant run is a separate Jest child
// process (native ESM via --experimental-vm-modules), so a mutant stuck in a
// synchronous loop is killed with its process group instead of freezing the CLI.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  DEFAULT_HIT_LIMIT,
  type DryRunResult,
  HIT_LIMIT_MESSAGE,
  type InstrumentOptions,
  type Mutant,
  type MutantRunResult,
  type Session,
  type SpawnedCommand,
  type TestInfo,
  type TestLocation,
  emptyDryRun,
  hash,
  instrument,
  numberDuplicates,
} from '@mizchi/mutator-core';
import { type JestProject, PARTIAL_REPORTER, mutatorJestConfig, readJestProject } from './config.ts';

export interface JestSessionOptions {
  root: string;
  /** Absolute paths of the source files to mutate. */
  targets: readonly string[];
  /** Jest config file; defaults to Jest's own lookup from `root`. */
  configFile?: string;
  arid?: InstrumentOptions['arid'];
  excludedMutators?: InstrumentOptions['excludedMutators'];
  /** Custom mutators / ignorers, used for `mutants()` in this process. */
  mutators?: InstrumentOptions['mutators'];
  ignorers?: InstrumentOptions['ignorers'];
  /** Absolute paths of the plugin modules providing `mutators` / `ignorers`; Jest's transformer loads them itself. */
  pluginModules?: readonly string[];
}

/** Jest start-up allowance added to every mutant timeout until a run has been measured. */
const DEFAULT_STARTUP_MS = 3000;

interface AssertionResult {
  fullName: string;
  status: string;
  duration?: number | null;
  failureMessages?: string[];
}

interface SuiteResult {
  name: string;
  status: string;
  message?: string;
  assertionResults: AssertionResult[];
}

interface JsonReport {
  testResults: SuiteResult[];
}

interface FileCoverage {
  testPath: string;
  static: Record<string, number>;
  perTest: Record<string, Record<string, number>>;
  /** Hits per mutant summed over the file's modules. */
  counts?: Record<string, number>;
  /** Test name -> processes it started. */
  spawns?: Record<string, SpawnedCommand[]>;
}

interface RunOutcome {
  report: JsonReport | undefined;
  /** Suites PARTIAL_REPORTER recorded as they finished (only when it was enabled). */
  partial: SuiteResult[];
  timedOut: boolean;
  stderr: string;
  wallMs: number;
}

export async function createJestSession(options: JestSessionOptions): Promise<Session> {
  const { root } = options;
  if ((options.mutators?.length || options.ignorers?.length) && !options.pluginModules?.length) {
    throw new Error('mutator: custom mutators / ignorers reach Jest only as plugin modules (pluginModules)');
  }
  const project: JestProject = await readJestProject(root, options.configFile);
  const dir = mkdtempSync(join(tmpdir(), 'mutator-jest-'));
  const configPath = join(dir, 'jest.config.json');
  const transformer = {
    root,
    targets: [...options.targets],
    pluginModules: [...(options.pluginModules ?? [])],
    ...(options.arid !== undefined ? { arid: options.arid } : {}),
    ...(options.excludedMutators ? { excludedMutators: options.excludedMutators } : {}),
  };
  writeFileSync(configPath, JSON.stringify(mutatorJestConfig(project, transformer, join(dir, 'cache'))));

  const locations = new Map<string, TestLocation>();
  let mutants: Mutant[] | undefined;
  let startupMs = DEFAULT_STARTUP_MS;
  let runs = 0;

  const jest = async (args: readonly string[], env: Record<string, string>, timeoutMs = Infinity): Promise<RunOutcome> => {
    const outputFile = join(dir, `report-${runs}.json`);
    const partialFile = join(dir, `partial-${runs++}.jsonl`);
    const argv = [
      '--experimental-vm-modules',
      '--disable-warning=ExperimentalWarning',
      project.bin,
      '--config',
      configPath,
      '--ci',
      '--silent',
      '--json',
      '--outputFile',
      outputFile,
      '--passWithNoTests',
      '--forceExit',
      ...args,
    ];
    const started = performance.now();
    const child = spawn(process.execPath, argv, {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, MUTATOR_PARTIAL_REPORT: partialFile, ...env },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    let timedOut = false;
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          timedOut = true;
          killGroup(child.pid);
        }, timeoutMs)
      : undefined;
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    clearTimeout(timer);
    // Workers Jest forked are in the same group; make sure none outlives the run.
    killGroup(child.pid);
    let report: JsonReport | undefined;
    try {
      report = JSON.parse(readFileSync(outputFile, 'utf8')) as JsonReport;
    } catch {
      report = undefined;
    }
    let partial: SuiteResult[] = [];
    try {
      partial = readFileSync(partialFile, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as SuiteResult);
    } catch {
      // No partial report (no early exit, or nothing finished): none is used.
    }
    rmSync(outputFile, { force: true });
    rmSync(partialFile, { force: true });
    return { report, partial, timedOut, stderr, wallMs: performance.now() - started };
  };

  const measure = (outcome: RunOutcome) => {
    if (!outcome.report) return;
    const testsMs = outcome.report.testResults.flatMap((s) => s.assertionResults).reduce((sum, a) => sum + (a.duration ?? 0), 0);
    startupMs = Math.max(1000, outcome.wallMs - testsMs);
  };

  return {
    mutants() {
      mutants ??= options.targets.flatMap(
        (file) =>
          instrument(file, readFileSync(file, 'utf8'), {
            identity: relative(root, file),
            ...(options.arid !== undefined ? { arid: options.arid } : {}),
            ...(options.excludedMutators ? { excludedMutators: options.excludedMutators } : {}),
            ...(options.mutators ? { mutators: options.mutators } : {}),
            ...(options.ignorers ? { ignorers: options.ignorers } : {}),
          }).mutants,
      );
      return mutants;
    },

    configFiles() {
      return [...new Set([...(project.configPath ? [project.configPath] : []), ...project.setupFiles])].sort();
    },

    async testFiles() {
      return listTests(project, configPath, root);
    },

    async dryRun(files) {
      if (files && files.length === 0) return emptyDryRun();
      const coverageDir = join(dir, `coverage-${runs}`);
      mkdirSync(coverageDir, { recursive: true });
      const outcome = await jest(files ? ['--runTestsByPath', ...files] : [], {
        MUTATOR_COVERAGE_DIR: coverageDir,
        MUTATOR_HIT_LIMIT: String(DEFAULT_HIT_LIMIT),
      });
      if (!outcome.report) throw new Error(`mutator: jest produced no report\n${outcome.stderr}`);
      measure(outcome);
      const coverage = new Map<string, FileCoverage>();
      for (const name of readdirSync(coverageDir)) {
        const file = JSON.parse(readFileSync(join(coverageDir, name), 'utf8')) as FileCoverage;
        coverage.set(file.testPath, file);
      }
      rmSync(coverageDir, { recursive: true, force: true });
      const dry = collectDryRun(outcome.report, coverage, root);
      for (const [id, location] of dry.index) locations.set(id, location);
      return dry;
    },

    useTestIndex(index) {
      locations.clear();
      for (const [id, location] of index) locations.set(id, location);
    },

    async runMutant(key, testIds, { timeoutMs, hitLimit = DEFAULT_HIT_LIMIT, earlyExit = true }) {
      const byFile = new Map<string, Set<string>>();
      for (const id of testIds) {
        const location = locations.get(id);
        if (!location) continue;
        const names = byFile.get(location.moduleId) ?? new Set();
        names.add(location.taskId);
        byFile.set(location.moduleId, names);
      }
      if (byFile.size === 0) return { status: 'Survived', killedBy: [], durationMs: 0 };
      const names = [...new Set([...byFile.values()].flatMap((s) => [...s]))];
      const pattern = `^(?:${names.map(escapeRegExp).join('|')})$`;
      const outcome = await jest(
        // --bail stops after the first failing test file; without it every file runs (--kill-matrix).
        // Bailing exits Jest before it writes the --json report, so the partial reporter records
        // each file as it finishes.
        [
          '--runInBand',
          ...(earlyExit ? ['--bail', '--reporters', PARTIAL_REPORTER] : []),
          '--testNamePattern',
          pattern,
          '--runTestsByPath',
          ...byFile.keys(),
        ],
        { MUTATOR_ACTIVE: key, MUTATOR_HIT_LIMIT: String(hitLimit) },
        timeoutMs + startupMs,
      );
      const durationMs = outcome.wallMs;
      if (outcome.timedOut) return { status: 'Timeout', timeoutCause: 'time', killedBy: [], durationMs };
      const report = outcome.report ?? bailedReport(outcome.partial);
      if (!report) return { status: 'RuntimeError', killedBy: [], durationMs };
      if (outcome.report) measure(outcome);
      return { ...classify(report, root, new Set(testIds)), durationMs };
    },

    async close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

async function listTests(project: JestProject, configPath: string, root: string): Promise<string[]> {
  const child = spawn(
    process.execPath,
    ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', project.bin, '--config', configPath, '--listTests', '--json'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  const json = stdout.slice(stdout.indexOf('['));
  try {
    return (JSON.parse(json) as string[]).sort();
  } catch {
    throw new Error(`mutator: jest --listTests failed (exit ${code})\n${stderr}`);
  }
}

/**
 * The results of a run Jest ended through --bail. Jest bails only once a test has failed,
 * so without a failed test the missing --json report means Jest itself broke.
 */
function bailedReport(partial: readonly SuiteResult[]): JsonReport | undefined {
  const bailed = partial.some((suite) => suite.assertionResults.some((a) => a.status === 'failed'));
  return bailed ? { testResults: [...partial] } : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const SKIPPED = new Set(['pending', 'skipped', 'todo', 'disabled', 'focused']);

/** Test ids with `#n` suffixes for duplicate full names, as the vitest session does. */
function* identify(suite: SuiteResult, root: string): Generator<{ id: string; assertion: AssertionResult; coverageKey: string }> {
  const rel = relative(root, suite.name);
  const distinct = numberDuplicates();
  const executed = numberDuplicates();
  for (const assertion of suite.assertionResults) {
    const id = distinct(`${rel}#${assertion.fullName}`);
    // The setup hooks only see executed tests; their counter skips skipped ones.
    const coverageKey = SKIPPED.has(assertion.status) ? assertion.fullName : executed(assertion.fullName);
    yield { id, assertion, coverageKey };
  }
}

function collectDryRun(report: JsonReport, coverageByFile: ReadonlyMap<string, FileCoverage>, root: string): DryRunResult {
  const dry = emptyDryRun();
  for (const suite of report.testResults) {
    const rel = relative(root, suite.name);
    const cov = coverageByFile.get(suite.name);
    const fileStatic = new Set<string>();
    dry.staticByFile.set(rel, fileStatic);
    for (const key of Object.keys(cov?.static ?? {})) {
      dry.staticKeys.add(key);
      fileStatic.add(key);
    }
    for (const [key, n] of Object.entries(cov?.counts ?? {})) dry.hits.set(key, (dry.hits.get(key) ?? 0) + n);
    if (suite.status === 'failed' && !suite.assertionResults.some((a) => a.status === 'failed')) dry.failed.push(rel);
    const fingerprint = hash(readFileSync(suite.name, 'utf8'));
    for (const { id, assertion, coverageKey } of identify(suite, root)) {
      dry.index.set(id, { moduleId: suite.name, taskId: assertion.fullName });
      if (SKIPPED.has(assertion.status)) continue;
      if (assertion.status === 'failed') dry.failed.push(id);
      const test: TestInfo = { id, fingerprint: hash(`${fingerprint}\0${id}`), durationMs: assertion.duration ?? 0 };
      dry.tests.push(test);
      const spawned = cov?.spawns?.[coverageKey];
      if (spawned) (dry.spawns ??= new Map()).set(id, spawned);
      for (const key of Object.keys(cov?.perTest[coverageKey] ?? {})) {
        const covering = dry.coverage.get(key) ?? [];
        covering.push(id);
        dry.coverage.set(key, covering);
      }
    }
  }
  return dry;
}

function classify(report: JsonReport, root: string, selected: ReadonlySet<string>): Omit<MutantRunResult, 'durationMs'> {
  const killedBy: string[] = [];
  const messages: string[] = [];
  let suiteError = false;
  for (const suite of report.testResults) {
    const failedTests = suite.assertionResults.some((a) => a.status === 'failed');
    if (suite.status === 'failed' && !failedTests) {
      suiteError = true;
      killedBy.push(relative(root, suite.name));
      messages.push(suite.message ?? '');
    }
    for (const { id, assertion } of identify(suite, root)) {
      if (assertion.status !== 'failed' || !selected.has(id)) continue;
      killedBy.push(id);
      messages.push((assertion.failureMessages ?? []).join('\n'));
    }
  }
  if (killedBy.length === 0) return { status: 'Survived', killedBy };
  // The hit limit guards against endless loops: a run stopped only by it is a timeout.
  if (messages.every((m) => m.includes(HIT_LIMIT_MESSAGE))) return { status: 'Timeout', timeoutCause: 'hitLimit', killedBy: [] };
  if (suiteError && killedBy.every((k) => !k.includes('#'))) return { status: 'RuntimeError', killedBy };
  return { status: 'Killed', killedBy };
}
