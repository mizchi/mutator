// Playwright session: mutation testing of browser code that Playwright tests drive through a
// Vite dev server. mutator starts the config's webServer itself, once, with the Vite plugin's
// instrumentation enabled (every mutant compiled in); each dry run and mutant run is a separate
// `playwright test` process, run through a generated config that extends the project's without
// its webServer. The fixture activates the mutant in the page and records coverage there.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  DEFAULT_HIT_LIMIT,
  type DryRunResult,
  type InstrumentOptions,
  type Mutant,
  type MutantRunResult,
  type Session,
  type TestLocation,
  emptyDryRun,
  hash,
  instrument,
} from '@mizchi/mutator-core';
import { EXPECT_TIMEOUT_ENV, RUN_ENV, type RunConfig, SETTINGS_ENV, type Settings, type TestRecord } from './env.ts';
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
const MIN_EXPECT_MS = 2000;

interface JsonTest {
  projectName: string;
  status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  results: { duration: number; status: string }[];
}

interface JsonSpec {
  title: string;
  file: string;
  line: number;
  tests: JsonTest[];
}

interface JsonSuite {
  title: string;
  file: string;
  specs: JsonSpec[];
  suites?: JsonSuite[];
}

interface JsonReport {
  config: {
    rootDir: string;
    configFile?: string;
    projects: { name: string }[];
    webServer?: WebServerConfig | WebServerConfig[] | null;
  };
  suites: JsonSuite[];
  errors?: { message?: string }[];
}

/** A test of a report, with what identifies it across the CLI, the report and the fixture. */
interface FoundTest {
  file: string;
  project: string;
  titles: string[];
  line: number;
  test: JsonTest;
}

/** A test's location, as `TestLocation.taskId`: where it is, and what it took in the dry run. */
interface Task {
  line: number;
  project: string;
  ms: number;
}

interface RunOutcome {
  report: JsonReport | undefined;
  timedOut: boolean;
  stderr: string;
  wallMs: number;
}

let generated = 0;

export async function createPlaywrightSession(options: PlaywrightSessionOptions): Promise<Session> {
  const { root } = options;
  const configFile = options.configFile ?? CONFIG_NAMES.map((name) => join(root, name)).find((file) => existsSync(file));
  if (!configFile) throw new Error(`mutator: no Playwright config (${CONFIG_NAMES.join(', ')}) in ${root}`);
  const cli = createRequire(join(root, 'package.json')).resolve('@playwright/test/cli');
  const configDir = dirname(configFile);

  const listing = await list(cli, configFile, root);
  const multiProject = listing.config.projects.length > 1;
  const idOf = (t: Pick<FoundTest, 'file' | 'project' | 'titles'>) => `${relative(root, t.file)}#${multiProject ? `[${t.project}] ` : ''}${t.titles.join(' > ')}`;

  const dir = mkdtempSync(join(tmpdir(), 'mutator-playwright-'));
  const settings: Settings = {
    root,
    targets: [...options.targets].sort(),
    pluginModules: [...(options.pluginModules ?? [])],
    ...(options.arid !== undefined ? { arid: options.arid } : {}),
    ...(options.excludedMutators ? { excludedMutators: options.excludedMutators } : {}),
    ...(options.weak !== undefined ? { weak: options.weak } : {}),
  };
  const settingsJson = JSON.stringify(settings);
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, settingsJson);

  // Next to the project's config, so the paths in it resolve as they do for Playwright.
  const wrapper = join(configDir, `.mutator-${process.pid}-${generated++}.playwright.config.ts`);
  writeFileSync(
    wrapper,
    [
      `import * as project from './${basename(configFile)}';`,
      `const config = ((project as { default?: object }).default ?? project) as { expect?: { timeout?: number } };`,
      `const limit = Number(process.env.${EXPECT_TIMEOUT_ENV});`,
      '// mutator runs the webServer itself, with the instrumentation enabled; in mutant runs it bounds expect timeouts.',
      'export default { ...config, webServer: undefined, ...(limit ? { expect: { ...config.expect, timeout: Math.min(config.expect?.timeout ?? 5000, limit) } } : {}) };',
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

  const locations = new Map<string, TestLocation>();
  let mutants: Mutant[] | undefined;
  let startupMs = DEFAULT_STARTUP_MS;
  let runs = 0;

  const playwright = async (args: readonly string[], run: RunConfig, timeoutMs = Infinity, env: Record<string, string> = {}): Promise<RunOutcome> => {
    await serve();
    const outputFile = join(dir, `report-${runs++}.json`);
    const started = performance.now();
    // --output: Playwright's artifacts (by default test-results/ next to the project's package.json) stay out of the project.
    const child = spawn(process.execPath, [cli, 'test', '--config', wrapper, '--reporter=json', '--retries=0', '--output', join(dir, 'results'), ...args], {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: outputFile, [RUN_ENV]: JSON.stringify(run), FORCE_COLOR: '0', ...env },
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
    await new Promise<void>((done) => child.on('close', () => done()));
    clearTimeout(timer);
    // Browsers and workers Playwright started are in the same group; make sure none outlives the run.
    killGroup(child.pid);
    let report: JsonReport | undefined;
    try {
      report = JSON.parse(readFileSync(outputFile, 'utf8')) as JsonReport;
    } catch {
      report = undefined;
    }
    rmSync(outputFile, { force: true });
    return { report, timedOut, stderr, wallMs: performance.now() - started };
  };

  const measure = (outcome: RunOutcome) => {
    if (!outcome.report) return;
    const testsMs = tests(outcome.report).reduce((sum, t) => sum + t.test.results.reduce((s, r) => s + r.duration, 0), 0);
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
            ...(options.weak !== undefined ? { weak: options.weak } : {}),
            ...(options.mutators ? { mutators: options.mutators } : {}),
            ...(options.ignorers ? { ignorers: options.ignorers } : {}),
          }).mutants,
      );
      return mutants;
    },

    configFiles() {
      return [configFile];
    },

    async testFiles() {
      return [...new Set(tests(listing).map((t) => t.file))].sort();
    },

    async dryRun(files) {
      if (files && files.length === 0) return emptyDryRun();
      const out = join(dir, `coverage-${runs}`);
      mkdirSync(out, { recursive: true });
      const outcome = await playwright(files ?? [], { active: null, hitLimit: DEFAULT_HIT_LIMIT, out });
      if (!outcome.report) throw new Error(`mutator: playwright produced no report\n${outcome.stderr}`);
      measure(outcome);
      const records: TestRecord[] = readdirSync(out).flatMap((name) =>
        readFileSync(join(out, name), 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as TestRecord),
      );
      rmSync(out, { recursive: true, force: true });
      const dry = collectDryRun(outcome.report, records, { root, idOf, targets: settings.targets });
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
      let slowestMs = 0;
      for (const id of testIds) {
        const location = locations.get(id);
        if (!location) continue;
        const { line, project, ms } = JSON.parse(location.taskId) as Task;
        filters.add(`${location.moduleId}:${line}`);
        projects.add(project);
        slowestMs = Math.max(slowestMs, ms);
      }
      if (filters.size === 0) return { status: 'Survived', killedBy: [], durationMs: 0 };
      const outcome = await playwright(
        [
          // One worker per run: mutator runs several mutants at once.
          '--workers=1',
          ...(earlyExit ? ['--max-failures=1'] : []),
          ...(multiProject ? [...projects].map((p) => `--project=${p}`) : []),
          ...filters,
        ],
        { active: key, hitLimit },
        timeoutMs + startupMs,
        { [EXPECT_TIMEOUT_ENV]: String(Math.max(MIN_EXPECT_MS, EXPECT_FACTOR * slowestMs)) },
      );
      const durationMs = outcome.wallMs;
      if (outcome.timedOut) return { status: 'Timeout', timeoutCause: 'time', killedBy: [], durationMs };
      if (!outcome.report) return { status: 'RuntimeError', killedBy: [], durationMs };
      measure(outcome);
      return { ...classify(outcome.report, idOf, new Set(testIds)), durationMs };
    },

    async close() {
      if (release) await (await release.catch(() => async () => {}))();
      removeWrapper();
      process.off('exit', removeWrapper);
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

/** `playwright test --list`: the config and the tests, without running anything (or starting a server). */
async function list(cli: string, configFile: string, root: string): Promise<JsonReport> {
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
    return JSON.parse(stdout.slice(stdout.indexOf('{'))) as JsonReport;
  } catch {
    throw new Error(`mutator: playwright test --list failed (exit ${code})\n${stderr}${stdout}`);
  }
}

/** Every test of a report, one per project. */
function tests(report: JsonReport): FoundTest[] {
  const out: FoundTest[] = [];
  const walk = (suite: JsonSuite, titles: readonly string[]) => {
    for (const spec of suite.specs) {
      for (const test of spec.tests) {
        out.push({ file: resolve(report.config.rootDir, spec.file), project: test.projectName, titles: [...titles, spec.title], line: spec.line, test });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  // The top-level suites are the test files; their titles are not part of a test's name.
  for (const file of report.suites) walk(file, []);
  return out;
}

function collectDryRun(report: JsonReport, records: readonly TestRecord[], input: { root: string; idOf: (t: Pick<FoundTest, 'file' | 'project' | 'titles'>) => string; targets: readonly string[] }): DryRunResult {
  const { root, idOf } = input;
  const dry = emptyDryRun();
  const recorded = new Map(records.map((r) => [idOf(r), r]));
  // The browser loads the sources, not the test files: any target may affect any test.
  const sources = input.targets.map((f) => relative(root, f)).sort();
  const fingerprints = new Map<string, string>();
  for (const found of tests(report)) {
    const id = idOf(found);
    const rel = relative(root, found.file);
    const task: Task = { line: found.line, project: found.project, ms: found.test.results.reduce((sum, r) => sum + r.duration, 0) };
    dry.index.set(id, { moduleId: found.file, taskId: JSON.stringify(task) });
    dry.deps.set(rel, sources);
    dry.staticByFile.set(rel, new Set());
    if (found.test.status === 'skipped') continue;
    if (found.test.status === 'unexpected') dry.failed.push(id);
    let fingerprint = fingerprints.get(found.file);
    if (!fingerprint) fingerprints.set(found.file, (fingerprint = hash(readFileSync(found.file, 'utf8'))));
    dry.tests.push({ id, fingerprint: hash(`${fingerprint}\0${id}`), durationMs: task.ms });
    const record = recorded.get(id);
    if (!record) continue;
    for (const key of Object.keys(record.hits)) dry.coverage.set(key, [...(dry.coverage.get(key) ?? []), id]);
    for (const key of Object.keys(record.infected)) (dry.infected ??= new Map()).set(key, [...(dry.infected.get(key) ?? []), id]);
    for (const [key, n] of Object.entries(record.counts)) dry.hits.set(key, (dry.hits.get(key) ?? 0) + n);
  }
  return dry;
}

function classify(report: JsonReport, idOf: (t: FoundTest) => string, selected: ReadonlySet<string>): Omit<MutantRunResult, 'durationMs'> {
  const killedBy = tests(report)
    .filter((t) => t.test.status === 'unexpected')
    .map(idOf)
    .filter((id) => selected.has(id));
  if (killedBy.length > 0) return { status: 'Killed', killedBy };
  // Errors outside any test (a test file failing to load, a global setup) under this mutant.
  if (report.errors?.length) return { status: 'RuntimeError', killedBy: [] };
  return { status: 'Survived', killedBy: [] };
}
