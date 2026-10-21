// Playwright session: mutation testing of browser code that Playwright tests drive through a
// Vite dev server. mutator starts the config's webServer itself, once, with the Vite plugin's
// instrumentation enabled (every mutant compiled in), and runs a Playwright process per run
// through a generated config that extends the project's without its webServer. The fixture
// activates the mutant in the page and records coverage there.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  type DryRunResult,
  HIT_LIMIT_MESSAGE,
  type InstrumentOptions,
  type Mutant,
  type MutantRunResult,
  type Session,
  type TestLocation,
  DEFAULT_HIT_LIMIT,
  emptyDryRun,
  hash,
  instrument,
  instrumentFlags,
  portableFlags,
  RunnerSetupError,
  scanImports,
  testFingerprint,
} from '@mizchi/mutator-core';
import { RUN_FILE_ENV, type RunConfig, type RunResults, SETTINGS_ENV, type Settings, type TestOutcome, type TestRecord } from './env.ts';
import { type RunRequest, type RunnerOutcome, createProcessRunner } from './runner.ts';
import { type WebServerConfig, acquireServers } from './server.ts';

export interface PlaywrightSessionOptions extends Pick<InstrumentOptions, 'arid' | 'excludedMutators' | 'weak'> {
  root: string;
  /** Absolute paths of the source files to mutate. */
  targets: readonly string[];
  /** Playwright config file; defaults to playwright.config.* in `root`. */
  configFile?: string;
  /** Custom mutators / ignorers, used for `mutants()` in this process. */
  mutators?: InstrumentOptions['mutators'];
  ignorers?: InstrumentOptions['ignorers'];
  /** Absolute paths of the plugin modules providing `mutators` / `ignorers`; the dev server loads them itself. */
  pluginModules?: readonly string[];
}

const CONFIG_NAMES = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((ext) => `playwright.config.${ext}`);
/** Playwright (and browser) start-up allowance added to every mutant timeout until a run has been measured. */
const DEFAULT_STARTUP_MS = 5000;
/**
 * In mutant runs an `expect` waits at most this many times as long as the slowest selected test
 * took in the dry run (and never below MIN_EXPECT_MS): a mutant that breaks the page otherwise
 * costs the whole expect timeout (5 s by default) per failing assertion.
 */
const EXPECT_FACTOR = 3;
const MIN_EXPECT_MS = 1000;

/** The `expect` timeout bound of a mutant run, from what its selected tests took in the dry run. */
export function expectTimeoutFor(durationsMs: readonly number[]): number {
  return Math.max(MIN_EXPECT_MS, EXPECT_FACTOR * Math.max(0, ...durationsMs));
}

/** `playwright test --list --reporter=json`, the parts used here. */
interface Listing {
  config: {
    rootDir: string;
    projects: { name: string }[];
    webServer?: WebServerConfig | WebServerConfig[] | null;
  };
  suites: ListedSuite[];
}

interface ListedSuite {
  specs: { file: string }[];
  suites?: ListedSuite[];
}

type TestKey = Pick<TestOutcome, 'file' | 'project' | 'titles'>;

/** A test's location, as `TestLocation.taskId`: where it is, and what it took in the dry run. */
interface Task {
  line: number;
  project: string;
  ms: number;
}

let generated = 0;

export async function createPlaywrightSession(options: PlaywrightSessionOptions): Promise<Session> {
  const { root } = options;
  const configFile = options.configFile ?? CONFIG_NAMES.map((name) => join(root, name)).find((file) => existsSync(file));
  if (!configFile) throw new RunnerSetupError(`mutator: no Playwright config (${CONFIG_NAMES.join(', ')}) in ${root}`);
  const cli = createRequire(join(root, 'package.json')).resolve('@playwright/test/cli');
  const configDir = dirname(configFile);

  const listing = await list(cli, configFile, root);
  const multiProject = listing.config.projects.length > 1;
  const idOf = (t: TestKey) => `${relative(root, t.file)}#${multiProject ? `[${t.project}] ` : ''}${t.titles.join(' > ')}`;

  const dir = mkdtempSync(join(tmpdir(), 'mutator-playwright-'));
  const settings: Settings = {
    root,
    targets: [...options.targets].sort(),
    pluginModules: [...(options.pluginModules ?? [])],
    ...portableFlags(options),
  };
  const settingsJson = JSON.stringify(settings);
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, settingsJson);
  const runFile = join(dir, 'run.json');

  // Next to the project's config, so the paths in it resolve as they do for Playwright.
  const wrapper = join(configDir, `.mutator-${process.pid}-${generated++}.playwright.config.ts`);
  writeFileSync(
    wrapper,
    [
      "import { readFileSync } from 'node:fs';",
      `import * as project from './${basename(configFile)}';`,
      'const config = ((project as { default?: object }).default ?? project) as { expect?: { timeout?: number } };',
      `const run = JSON.parse(readFileSync(process.env.${RUN_FILE_ENV}!, 'utf8')) as { expectTimeout?: number };`,
      'const timeout = config.expect?.timeout ?? 5000;',
      '// mutator runs the webServer itself, with the instrumentation enabled.',
      'export default {',
      '  ...config,',
      '  webServer: undefined,',
      '  expect: { ...config.expect, timeout: run.expectTimeout ? Math.min(timeout, run.expectTimeout) : timeout },',
      '};',
      '',
    ].join('\n'),
  );
  const removeWrapper = () => rmSync(wrapper, { force: true });
  process.once('exit', removeWrapper);

  const servers = [listing.config.webServer ?? []].flat();
  let release: Promise<() => Promise<void>> | undefined;
  // The sessions of one CLI run share the servers: the same settings start the same ones (the
  // dev server reads the settings file once, when it starts).
  const serve = () => (release ??= acquireServers(hash(`${settingsJson}\0${JSON.stringify(servers)}`), servers, { configDir, env: { [SETTINGS_ENV]: settingsPath } }));

  const runner = createProcessRunner({ cli, config: wrapper, cwd: root, runFile, outputDir: join(dir, 'results') });

  const locations = new Map<string, TestLocation>();
  let mutants: Mutant[] | undefined;
  let startupMs = DEFAULT_STARTUP_MS;
  let runs = 0;

  const playwright = async (request: Omit<RunRequest, 'results'>, run: Omit<RunConfig, 'results'>, timeoutMs = Infinity): Promise<RunnerOutcome> => {
    await serve();
    const results = join(dir, `results-${runs++}.json`);
    writeFileSync(runFile, JSON.stringify({ ...run, results } satisfies RunConfig));
    return runner.run({ ...request, results }, timeoutMs);
  };

  const measure = (outcome: RunnerOutcome) => {
    if (!outcome.results) return;
    const testsMs = outcome.results.tests.reduce((sum, t) => sum + t.durationMs, 0);
    startupMs = Math.max(500, outcome.wallMs - testsMs);
  };

  return {
    mutants() {
      mutants ??= options.targets.flatMap(
        (file) =>
          instrument(file, readFileSync(file, 'utf8'), { identity: relative(root, file), ...instrumentFlags(options) }).mutants,
      );
      return mutants;
    },

    configFiles() {
      return [configFile];
    },

    async testFiles() {
      return listedFiles(listing);
    },

    async dryRun(files) {
      if (files && files.length === 0) return emptyDryRun();
      const out = join(dir, `coverage-${runs}`);
      mkdirSync(out, { recursive: true });
      const outcome = await playwright({ locations: files ?? [], projects: [] }, { active: null, hitLimit: DEFAULT_HIT_LIMIT, out });
      if (!outcome.results) throw new Error(`mutator: playwright produced no results\n${outcome.stderr}`);
      measure(outcome);
      const records: TestRecord[] = readdirSync(out).flatMap((name) =>
        readFileSync(join(out, name), 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as TestRecord),
      );
      rmSync(out, { recursive: true, force: true });
      const dry = collectDryRun(outcome.results, records, { root, idOf, targets: settings.targets });
      for (const [id, location] of dry.index) locations.set(id, location);
      return dry;
    },

    useTestIndex(index) {
      locations.clear();
      for (const [id, location] of index) locations.set(id, location);
    },

    async runMutant(key, testIds, { timeoutMs, hitLimit = DEFAULT_HIT_LIMIT, earlyExit = true }) {
      const filters = new Set<string>();
      const projects = new Set<string>();
      const durations: number[] = [];
      for (const id of testIds) {
        const location = locations.get(id);
        if (!location) continue;
        const { line, project, ms } = JSON.parse(location.taskId) as Task;
        filters.add(`${location.moduleId}:${line}`);
        // A `file:line` filter matches the test in every project. (`--project=` for the unnamed default selects it too.)
        projects.add(project);
        durations.push(ms);
      }
      if (filters.size === 0) return { status: 'Survived', killedBy: [], durationMs: 0 };
      const outcome = await playwright(
        {
          locations: [...filters],
          projects: [...projects],
          // One worker per run: mutator runs several mutants at once.
          workers: 1,
          ...(earlyExit ? { maxFailures: 1 } : {}),
        },
        { active: key, hitLimit, expectTimeout: expectTimeoutFor(durations) },
        timeoutMs + startupMs,
      );
      const durationMs = outcome.wallMs;
      if (outcome.timedOut) return { status: 'Timeout', timeoutCause: 'time', killedBy: [], durationMs };
      if (!outcome.results) return { status: 'RuntimeError', killedBy: [], durationMs };
      measure(outcome);
      return { ...classify(outcome.results, idOf, new Set(testIds)), durationMs };
    },

    async close() {
      if (release) await (await release.catch(() => async () => {}))();
      removeWrapper();
      process.off('exit', removeWrapper);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** `playwright test --list`: the config and the tests, without running anything (or starting a server). */
async function list(cli: string, configFile: string, root: string): Promise<Listing> {
  const child = spawn(process.execPath, [cli, 'test', '--list', '--reporter=json', '--config', configFile], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  const code = await new Promise<number | null>((done) => child.on('close', done));
  try {
    return JSON.parse(stdout.slice(stdout.indexOf('{'))) as Listing;
  } catch {
    throw new RunnerSetupError(`mutator: playwright test --list failed (exit ${code})\n${stderr}${stdout}`);
  }
}

/** The test files of a listing. */
function listedFiles(listing: Listing): string[] {
  const out = new Set<string>();
  const walk = (suite: ListedSuite) => {
    for (const spec of suite.specs) out.add(resolve(listing.config.rootDir, spec.file));
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const file of listing.suites) walk(file);
  return [...out].sort();
}

function collectDryRun(results: RunResults, records: readonly TestRecord[], input: { root: string; idOf: (t: TestKey) => string; targets: readonly string[] }): DryRunResult {
  const { root, idOf } = input;
  const dry = emptyDryRun();
  const recorded = new Map(records.map((r) => [idOf(r), r]));
  // The browser loads the sources, not the test files: any target may affect any test. A test
  // file also depends on the local files it imports (helpers, fixtures): editing one re-collects it.
  const sources = input.targets.map((f) => relative(root, f));
  const depsOf = new Map<string, string[]>();
  const deps = (file: string) => {
    let out = depsOf.get(file);
    if (!out) depsOf.set(file, (out = [...new Set([...sources, ...localImports(file).map((f) => relative(root, f))])].sort()));
    return out;
  };
  const fingerprints = new Map<string, string>();
  for (const found of results.tests) {
    const id = idOf(found);
    const rel = relative(root, found.file);
    const task: Task = { line: found.line, project: found.project, ms: found.durationMs };
    dry.index.set(id, { moduleId: found.file, taskId: JSON.stringify(task) });
    dry.deps.set(rel, deps(found.file));
    dry.staticByFile.set(rel, new Set());
    if (found.outcome === 'skipped') continue;
    if (found.outcome === 'unexpected') dry.failed.push(id);
    let fingerprint = fingerprints.get(found.file);
    if (!fingerprint) fingerprints.set(found.file, (fingerprint = hash(readFileSync(found.file, 'utf8'))));
    dry.tests.push({ id, fingerprint: testFingerprint(fingerprint, id), durationMs: found.durationMs });
    const record = recorded.get(id);
    if (!record) continue;
    for (const key of Object.keys(record.hits)) dry.coverage.set(key, [...(dry.coverage.get(key) ?? []), id]);
    for (const key of Object.keys(record.infected)) (dry.infected ??= new Map()).set(key, [...(dry.infected.get(key) ?? []), id]);
    for (const [key, n] of Object.entries(record.counts)) dry.hits.set(key, (dry.hits.get(key) ?? 0) + n);
  }
  // Errors outside any test (a test file failing to load, a global setup) fail the run without a mutant.
  dry.failed.push(...results.errors.map((e) => `playwright: ${e.split('\n')[0]}`));
  return dry;
}

function classify(results: RunResults, idOf: (t: TestKey) => string, selected: ReadonlySet<string>): Omit<MutantRunResult, 'durationMs'> {
  const failed = results.tests.filter((t) => t.outcome === 'unexpected' && selected.has(idOf(t)));
  // The hit limit guards against endless loops: a run stopped only by it is a timeout.
  if (failed.length > 0 && failed.every((t) => t.messages.length > 0 && t.messages.every((m) => m.includes(HIT_LIMIT_MESSAGE)))) {
    return { status: 'Timeout', timeoutCause: 'hitLimit', killedBy: [] };
  }
  const killedBy = failed.map(idOf);
  if (killedBy.length > 0) return { status: 'Killed', killedBy };
  // Errors outside any test (a test file failing to load, a global setup) under this mutant.
  if (results.errors.length > 0) return { status: 'RuntimeError', killedBy: [] };
  return { status: 'Survived', killedBy: [] };
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.js'];

/** Local files `file` imports through relative specifiers, transitively (absolute paths, `file` excluded). */
export function localImports(file: string): string[] {
  const seen = new Set<string>([file]);
  const pending = [file];
  while (pending.length > 0) {
    const from = pending.pop()!;
    let loads: string[];
    try {
      loads = scanImports(from, readFileSync(from, 'utf8')).loads;
    } catch {
      continue;
    }
    for (const specifier of loads) {
      if (!specifier.startsWith('.')) continue;
      const base = resolve(dirname(from), specifier);
      const target = RESOLVE_SUFFIXES.map((suffix) => base + suffix).find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (target && !seen.has(target)) seen.add(target), pending.push(target);
    }
  }
  seen.delete(file);
  return [...seen];
}
