// Bun session: every dry run and every mutant run is a separate `bun test` process. Bun has no
// programmatic runner API, but it starts in milliseconds, so a process per run stays cheap.
// The sources are instrumented once, in this process; a preload serves them to Bun through a
// runtime plugin. `--isolate` gives each test file a fresh global and module registry, so the
// preload knows which file ran (Bun.main) and static mutants are attributed to every file that
// loads them. Test names and verdicts come from Bun's JUnit report.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DryRunResult,
  type InstrumentOptions,
  type Mutant,
  type RunReport,
  type Session,
  type SpawnedCommand,
  type TestInfo,
  type TestLocation,
  DEFAULT_HIT_LIMIT,
  HIT_LIMIT_MESSAGE,
  RunnerSetupError,
  classifyRun,
  emptyDryRun,
  hash,
  instrument,
  instrumentFlags,
  numberDuplicates,
  portableFlags,
  testFingerprint,
  relativePath as relative,
} from '@mizchi/mutator-core';
import { type Bunfig, listTestFiles, readBunfig } from './config.ts';
import { type JunitFile, parseJunit } from './junit.ts';

// Published builds run from dist/; the preload ships in src/.
export const PRELOAD = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './preload.js' : '../src/preload.js', import.meta.url));

export interface BunSessionOptions {
  root: string;
  /** Absolute paths of the source files to mutate. */
  targets: readonly string[];
  /** bunfig.toml to run with (`bun test --config`); defaults to Bun's own `<root>/bunfig.toml`. */
  configFile?: string;
  /** Worker processes for dry runs (`bun test --parallel`). Mutants run in one process. */
  maxWorkers?: number;
  arid?: InstrumentOptions['arid'];
  excludedMutators?: InstrumentOptions['excludedMutators'];
  weak?: InstrumentOptions['weak'];
  mutators?: InstrumentOptions['mutators'];
  ignorers?: InstrumentOptions['ignorers'];
  /** Module paths behind `mutators` / `ignorers`; sessions with the same ones share the instrumented sources. */
  pluginModules?: readonly string[];
}

/** Bun start-up allowance added to every mutant timeout until a run has been measured. */
const DEFAULT_STARTUP_MS = 2000;
/** Longer name patterns run whole files instead (a command-line argument has a size limit). */
const MAX_PATTERN = 32 * 1024;

/** One test file's record, written by the preload once its tests are done. */
interface FileRecord {
  file: string;
  /** False when the file failed to load. */
  loaded: boolean;
  /** Tests that started, numbered from 0 in that order. */
  tests: number;
  /** Tests overlapped (test.concurrent): hits cannot be told apart. */
  overlap: boolean;
  /** The run exceeded its hit limit. */
  hitLimit: boolean;
  // Dry runs only:
  static?: Record<string, number>;
  perTest?: Record<string, Record<string, number>>;
  infected?: Record<string, Record<string, number>>;
  counts?: Record<string, number>;
  spawns?: Record<string, SpawnedCommand[]>;
  /** The module registry: every module the file loaded (absolute). */
  modules?: string[];
}

interface RunOutcome {
  junit: JunitFile[] | undefined;
  records: Map<string, FileRecord>;
  code: number | null;
  timedOut: boolean;
  stderr: string;
  wallMs: number;
}

/** Instrumented sources, shared by the sessions of one run (they all mutate the same targets). */
interface Prepared {
  /** Key in `prepared`; none when plugin objects make the sources unshareable. */
  key: string | undefined;
  dir: string;
  manifest: string;
  mutants: Mutant[];
  refs: number;
}

const prepared = new Map<string, Prepared>();

function prepare(options: BunSessionOptions): Prepared {
  const objects = (options.mutators?.length || options.ignorers?.length) && !options.pluginModules?.length;
  const key = objects
    ? undefined
    : JSON.stringify([options.root, [...options.targets].sort(), portableFlags(options), [...(options.pluginModules ?? [])].sort()]);
  const shared = key === undefined ? undefined : prepared.get(key);
  if (shared) {
    shared.refs++;
    return shared;
  }
  const dir = mkdtempSync(join(tmpdir(), 'mutator-bun-'));
  mkdirSync(join(dir, 'src'));
  const files: [string, string, string][] = [];
  const mutants: Mutant[] = [];
  options.targets.forEach((file, i) => {
    const result = instrument(file, readFileSync(file, 'utf8'), { identity: relative(options.root, file), ...instrumentFlags(options) });
    mutants.push(...result.mutants);
    const code = join(dir, 'src', `${i}${extname(file)}`);
    writeFileSync(code, result.code);
    files.push([file, code, loaderOf(file)]);
  });
  const manifest = join(dir, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ files, filter: pathFilter(options.targets) }));
  const value = { key, dir, manifest, mutants, refs: 1 };
  if (key !== undefined) prepared.set(key, value);
  return value;
}

/**
 * A regex source matching exactly these absolute paths, with either separator (Bun may report
 * Windows paths with `/` or `\`). Grouped by directory: Bun compiles it in every test file,
 * and a flat alternation of whole paths takes tens of milliseconds there in a large project.
 */
export function pathFilter(files: readonly string[]): string {
  const sep = '[\\\\/]';
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const parts = file.split(/[\\/]/).map(escapeRegExp);
    const base = parts.pop()!;
    const dir = parts.join(sep);
    const bases = byDir.get(dir);
    if (bases) bases.push(base);
    else byDir.set(dir, [base]);
  }
  return `^(?:${[...byDir].map(([dir, bases]) => `${dir}${sep}(?:${bases.join('|')})`).join('|')})$`;
}

/** Bun's loader for a source; Bun's own `.js` loader accepts JSX too. */
function loaderOf(file: string): string {
  const ext = extname(file);
  if (ext === '.tsx') return 'tsx';
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'ts';
  return 'jsx';
}

const checked = new Map<string, string | Error>();

/** Fails with a setup error unless `bin` runs a Bun whose test runner has --isolate. */
function checkBun(bin: string, root: string): void {
  let verdict = checked.get(bin);
  if (verdict === undefined) {
    const help = spawnSync(bin, ['test', '--help'], { cwd: root, encoding: 'utf8' });
    if (help.error) {
      verdict = new RunnerSetupError(`mutator: cannot run Bun (${bin}): ${help.error.message}. Install Bun (https://bun.com) or put it on PATH.`);
    } else if (!/--isolate\b/.test(`${help.stdout}${help.stderr}`)) {
      const version = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout?.trim() || 'unknown';
      verdict = new RunnerSetupError(`mutator: Bun ${version} has no \`bun test --isolate\`; upgrade Bun to use it with mutator.`);
    } else verdict = 'ok';
    checked.set(bin, verdict);
  }
  if (verdict instanceof Error) throw verdict;
}

export async function createBunSession(options: BunSessionOptions): Promise<Session> {
  const { root } = options;
  const bin = process.versions.bun ? process.execPath : 'bun';
  checkBun(bin, root);
  const bunfig: Bunfig = readBunfig(root, options.configFile);
  const shared = prepare(options);
  const dir = mkdtempSync(join(shared.dir, 'session-'));

  const locations = new Map<string, TestLocation>();
  let startupMs = DEFAULT_STARTUP_MS;
  let runs = 0;
  const children = new Set<ChildProcess>();

  const bunTest = async (args: readonly string[], env: Record<string, string>, timeoutMs = Infinity): Promise<RunOutcome> => {
    const run = runs++;
    const junitFile = join(dir, `junit-${run}.xml`);
    const outDir = join(dir, `out-${run}`);
    mkdirSync(outDir);
    const argv = [
      'test',
      '--isolate',
      '--preload',
      PRELOAD,
      '--reporter=junit',
      `--reporter-outfile=${junitFile}`,
      '--pass-with-no-tests',
      ...(options.configFile ? [`--config=${bunfig.path}`] : []),
      ...args,
    ];
    const started = performance.now();
    const child = spawn(bin, argv, {
      cwd: root,
      detached: true,
      // Test output is not read; a test writing megabytes to stdout must not block the run.
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, MUTATOR_BUN_MANIFEST: shared.manifest, MUTATOR_BUN_OUT: outDir, ...env },
    });
    children.add(child);
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    let timedOut = false;
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          timedOut = true;
          killGroup(child);
        }, timeoutMs)
      : undefined;
    const code = await new Promise<number | null>((done) => {
      child.on('error', (error) => {
        stderr += String(error);
        done(null);
      });
      child.on('close', (exitCode) => done(exitCode));
    });
    clearTimeout(timer);
    // Workers of --parallel are in the same group; make sure none outlives the run.
    killGroup(child);
    children.delete(child);
    let junit: JunitFile[] | undefined;
    try {
      junit = parseJunit(readFileSync(junitFile, 'utf8'));
    } catch {
      junit = undefined;
    }
    const found: FileRecord[] = [];
    for (const name of readdirSync(outDir)) {
      try {
        found.push(JSON.parse(readFileSync(join(outDir, name), 'utf8')) as FileRecord);
      } catch {
        // A record cut short by a killed process tells nothing.
      }
    }
    // By file, so that what is derived from them does not depend on the directory order.
    const records = new Map(found.map((r) => [normalize(r.file), r] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    rmSync(junitFile, { force: true });
    rmSync(outDir, { recursive: true, force: true });
    return { junit, records, code, timedOut, stderr, wallMs: performance.now() - started };
  };

  const measure = (outcome: RunOutcome) => {
    if (!outcome.junit) return;
    const testsMs = outcome.junit.flatMap((f) => f.tests).reduce((sum, t) => sum + t.durationMs, 0);
    startupMs = Math.max(500, outcome.wallMs - testsMs);
  };

  return {
    mutants: () => shared.mutants,

    configFiles() {
      return [...new Set([...(bunfig.path ? [bunfig.path] : []), ...bunfig.preload])].filter((f) => existsSync(f)).sort();
    },

    async testFiles() {
      return listTestFiles(bunfig.testRoot ?? root);
    },

    async dryRun(files) {
      if (files && files.length === 0) return emptyDryRun();
      const count = files?.length ?? Infinity;
      const workers = Math.min(options.maxWorkers ?? availableParallelism(), count);
      const outcome = await bunTest([...(workers > 1 ? [`--parallel=${workers}`] : []), ...(files ?? [])], { MUTATOR_HIT_LIMIT: String(DEFAULT_HIT_LIMIT) });
      if (noOutput(outcome)) throw new Error(`mutator: bun test wrote no report (exit ${outcome.code})\n${outcome.stderr}`);
      measure(outcome);
      const dry = collectDryRun(outcome, root);
      for (const [id, location] of dry.index) locations.set(id, location);
      return dry;
    },

    useTestIndex(index) {
      locations.clear();
      for (const [id, location] of index) locations.set(id, location);
    },

    async runMutant(mutantKey, testIds, { timeoutMs, isStatic = false, hitLimit = DEFAULT_HIT_LIMIT, earlyExit = true }) {
      const names = new Set<string>();
      const files = new Set<string>();
      for (const id of testIds) {
        const location = locations.get(id);
        if (!location) continue;
        files.add(location.moduleId);
        names.add(location.taskId);
      }
      if (files.size === 0) return { status: 'Survived', killedBy: [], durationMs: 0 };
      // A static mutant runs whole files, as it is active while they load.
      const pattern = `^(?:${[...names].map(escapeRegExp).join('|')})$`;
      const filter = isStatic || pattern.length > MAX_PATTERN ? [] : [`--test-name-pattern=${pattern}`];
      const run = (args: readonly string[]) =>
        bunTest([...(earlyExit ? ['--bail'] : []), ...args, ...files], { MUTATOR_ACTIVE: mutantKey, MUTATOR_HIT_LIMIT: String(hitLimit) }, timeoutMs + startupMs);
      let outcome = await run(filter);
      let durationMs = outcome.wallMs;
      // The report drops characters XML cannot hold (NUL and other control characters), so a
      // pattern built from it misses a test named with them. Selected tests that did not run,
      // with nothing failing, are run again through their whole files.
      if (filter.length > 0 && !outcome.timedOut && outcome.junit && notRun(outcome, root, testIds, locations)) {
        outcome = await run([]);
        durationMs += outcome.wallMs;
      }
      if (outcome.timedOut) return { status: 'Timeout', timeoutCause: 'time', killedBy: [], durationMs };
      // The process died: a mutant calling process.exit, a crash.
      if (noOutput(outcome)) return { status: 'RuntimeError', killedBy: [], durationMs };
      measure(outcome);
      return { ...classifyRun(runReport(outcome, root, testIds)), durationMs };
    },

    async close() {
      for (const child of children) killGroup(child);
      rmSync(dir, { recursive: true, force: true });
      if (--shared.refs === 0) {
        if (shared.key !== undefined) prepared.delete(shared.key);
        rmSync(shared.dir, { recursive: true, force: true });
      }
    },
  };
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** The test ids of a reported file, `#n` numbering repeated full names in report order. */
function* identify(file: JunitFile, root: string): Generator<{ id: string; test: JunitFile['tests'][number] }> {
  const rel = relative(root, resolve(root, file.file));
  const distinct = numberDuplicates();
  for (const test of file.tests) yield { id: distinct(`${rel}#${test.fullName}`), test };
}

/** Every key of every test's bucket. */
const union = (buckets: Record<string, Record<string, number>> | undefined) => new Set(Object.values(buckets ?? {}).flatMap((b) => Object.keys(b)));

/** Local modules a test file loaded (the preload leaves out node_modules): without itself and the preload, existing files only. */
function localDeps(record: FileRecord | undefined, abs: string, root: string, exists: (file: string) => boolean): string[] {
  const own = new Set([normalize(abs), normalize(PRELOAD)]);
  return (record?.modules ?? [])
    .map((m) => normalize(m))
    .filter((m) => !own.has(m) && exists(m))
    .map((m) => relative(root, m))
    .sort();
}

function collectDryRun(outcome: RunOutcome, root: string): DryRunResult {
  const dry = emptyDryRun();
  const infected = new Map<string, string[]>();
  const spawns = new Map<string, SpawnedCommand[]>();
  const credit = (map: Map<string, string[]>, keys: Iterable<string>, id: string) => {
    for (const key of keys) {
      const ids = map.get(key) ?? [];
      ids.push(id);
      map.set(key, ids);
    }
  };
  // Test files share most of their dependencies.
  const found = new Map<string, boolean>();
  const exists = (file: string) => found.get(file) ?? found.set(file, existsSync(file)).get(file)!;
  /** What a test file loaded: its static mutants and local dependencies. */
  const addFile = (abs: string, record: FileRecord | undefined) => {
    const rel = relative(root, abs);
    const fileStatic = new Set(Object.keys(record?.static ?? {}));
    dry.staticByFile.set(rel, fileStatic);
    for (const key of fileStatic) dry.staticKeys.add(key);
    dry.deps.set(rel, localDeps(record, abs, root, exists));
  };
  const reported = new Set<string>();
  for (const file of outcome.junit ?? []) {
    const abs = normalize(resolve(root, file.file));
    reported.add(abs);
    const record = outcome.records.get(abs);
    addFile(abs, record);
    for (const [key, n] of Object.entries(record?.counts ?? {})) dry.hits.set(key, (dry.hits.get(key) ?? 0) + n);
    const executed = file.tests.filter((t) => t.state !== 'skipped').length;
    // Tests are paired with the preload's numbers in order; when that cannot be trusted,
    // every test of the file is credited with all of the file's hits.
    const aligned = record !== undefined && !record.overlap && record.tests === executed;
    const allHits = aligned ? undefined : union(record?.perTest);
    const allInfected = aligned ? undefined : union(record?.infected);
    const fingerprint = hash(readFileSync(abs, 'utf8'));
    let slot = 0;
    for (const { id, test } of identify(file, root)) {
      dry.index.set(id, { moduleId: abs, taskId: test.fullName });
      if (test.state === 'skipped') continue;
      const n = String(slot++);
      if (test.state === 'failed') dry.failed.push(id);
      const info: TestInfo = { id, fingerprint: testFingerprint(fingerprint, id), durationMs: test.durationMs };
      dry.tests.push(info);
      credit(dry.coverage, allHits ?? Object.keys(record?.perTest?.[n] ?? {}), id);
      credit(infected, allInfected ?? Object.keys(record?.infected?.[n] ?? {}), id);
      const spawned = aligned ? record?.spawns?.[n] : Object.values(record?.spawns ?? {}).flat();
      if (spawned?.length) spawns.set(id, spawned);
    }
  }
  // Files with no tests in the report: those that failed to load, and those without tests.
  for (const [file, record] of outcome.records) {
    if (reported.has(file)) continue;
    if (!record.loaded) dry.failed.push(relative(root, file));
    addFile(file, record);
  }
  if (dry.failed.length === 0 && outcome.code !== 0) dry.failed.push(exitError(outcome));
  return { ...dry, infected, spawns };
}

/**
 * Neither a report nor a record: the process died before writing either. Bun writes no
 * report when no file loaded, but the preload has recorded each of those files.
 */
function noOutput(outcome: RunOutcome): boolean {
  return !outcome.junit && outcome.records.size === 0;
}

/** `bun test` failed outside any test; with the first error line of its output. */
function exitError(outcome: RunOutcome): string {
  const line = outcome.stderr.split('\n').find((l) => /^\s*(?:error|\w*Error):/.test(l));
  return `bun test exited with code ${outcome.code}${line ? `: ${line.trim()}` : ''}`;
}

/** Whether a run that failed nothing left out some of the selected tests. */
function notRun(outcome: RunOutcome, root: string, testIds: readonly string[], locations: ReadonlyMap<string, TestLocation>): boolean {
  if ([...outcome.records.values()].some((r) => !r.loaded)) return false;
  const ran = new Set<string>();
  for (const file of outcome.junit ?? []) {
    for (const { id, test } of identify(file, root)) {
      if (test.state === 'failed') return false;
      if (test.state !== 'skipped') ran.add(id);
    }
  }
  return testIds.some((id) => locations.has(id) && !ran.has(id));
}

/** The run as classifyRun reads it. */
function runReport(outcome: RunOutcome, root: string, testIds: readonly string[]): RunReport {
  const tests: RunReport['tests'][number][] = [];
  for (const file of outcome.junit ?? []) {
    for (const { id, test } of identify(file, root)) tests.push({ id, failed: test.state === 'failed', messages: test.messages });
  }
  // A file that failed to load is missing from the report; the preload's record tells.
  const fileErrors: RunReport['fileErrors'][number][] = [];
  for (const [file, record] of outcome.records) {
    if (!record.loaded) fileErrors.push({ file: relative(root, file), message: record.hitLimit ? HIT_LIMIT_MESSAGE : 'failed to load' });
  }
  // Bun exits non-zero without a failed test or file for an error between tests.
  const runErrors = outcome.code !== 0 && !tests.some((t) => t.failed) && fileErrors.length === 0 ? [exitError(outcome)] : [];
  return { tests, fileErrors, runErrors, selected: new Set(testIds) };
}
