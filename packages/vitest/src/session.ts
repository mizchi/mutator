import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, matchesGlob, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { debuglog } from 'node:util';
import {
  type DryRunResult,
  type MutantRunResult,
  type RunReport,
  type Session,
  type SpawnedCommand,
  type TestInfo,
  type TestLocation,
  DEFAULT_HIT_LIMIT,
  classifyRun,
  emptyDryRun,
  hash,
  numberDuplicates,
  testFingerprint,
  relativePath as relative,
} from '@mizchi/mutator-core';
import type { TestCase, TestModule, TestProject, TestRunResult, Vitest } from 'vitest/node';
import type { Plugin, UserWorkspaceConfig } from 'vitest/config';
import { MutantRegistry, type PluginOptions, mutatorPlugin } from './plugin.ts';
import type {} from './provided.ts';
import { resolveTestRuntime } from './runtime.ts';
import { collectDeps, relatedTestFiles } from './dependencies.ts';

// The runner contract lives in core; re-exported for convenience.
export type { DryRunResult, MutantRunResult, RunMutantOptions, Session, TestLocation } from '@mizchi/mutator-core';

// Published builds ship setup.js next to session.js.
const SETUP_FILE = realpathSync.native(fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './setup.ts' : './setup.js', import.meta.url)));
// Matches the setup file's module id, which Vite writes with forward slashes on every platform.
const SETUP_ID = new RegExp(`^${SETUP_FILE.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[?#]|$)`);
const debug = debuglog('mutator');

export interface SessionOptions extends PluginOptions {
  root: string;
  /** Path to a vitest config file; defaults to vitest's own lookup from `root`. */
  configFile?: string;
  /** Worker threads of this Vitest instance (sessions running mutants in parallel use 1 each). */
  maxWorkers?: number;
  /** Stop a mutant run at the first failing test (default: true). */
  earlyExit?: boolean;
  /**
   * Vitest pool (default: 'forks'). Forks are force-killed on timeout, and one crashing
   * cannot take the CLI down; force-terminating a thread stuck in a loop occasionally
   * crashes the whole process. 'threads' starts faster.
   */
  pool?: 'threads' | 'forks';
}

/**
 * Observes failures while a mutant run is in flight. Kills are taken from these
 * observations instead of the final task states, because a cancelled run may
 * report its failed test as pending.
 */
class FailureWatch {
  failed: TestCase[] = [];
  private onFailure: (() => void) | undefined;
  private onProgress: (() => void) | undefined;

  arm(onFailure: (() => void) | undefined, onProgress?: () => void): void {
    this.failed = [];
    this.onFailure = onFailure;
    this.onProgress = onProgress;
  }

  disarm(): TestCase[] {
    this.onFailure = undefined;
    this.onProgress = undefined;
    return this.failed;
  }

  onTestCaseReady(): void {
    this.onProgress?.();
  }

  onTestCaseResult(test: TestCase): void {
    this.onProgress?.();
    if (!this.onFailure || test.result().state !== 'failed') return;
    this.failed.push(test);
    const notify = this.onFailure;
    if (this.failed.length === 1) notify();
  }
}

export async function createSession(options: SessionOptions): Promise<Session> {
  const registry = new MutantRegistry();
  // Each instance gets its own watch so a closed instance cannot report into the next run.
  let { vitest, watch } = await start(options, registry);
  const locations = new Map<string, TestLocation>();
  // Vitest task id -> our test id (which disambiguates duplicate names).
  const byTask = new Map<string, string>();
  const locate = (id: string, location: TestLocation) => {
    locations.set(id, location);
    byTask.set(location.taskId, id);
  };
  const idOf = (test: TestCase) => byTask.get(test.id) ?? testId(options.root, test, vitest.projects.length > 1);

  const sessionEarlyExit = options.earlyExit !== false;
  const run = async (active: string | null, hitLimit: number, specs: Parameters<Vitest['runTestSpecifications']>[0], earlyExit = sessionEarlyExit) => {
    vitest.provide('mutator', { active, hitLimit, earlyExit });
    for (const project of vitest.projects) project.provide('mutator', { active, hitLimit, earlyExit });
    return vitest.runTestSpecifications(specs);
  };

  return {
    mutants: () => registry.all(),

    configFiles() {
      const files = new Set<string>();
      for (const project of vitest.projects) {
        const configFile = (project.vite.config as { configFile?: string | false }).configFile;
        if (configFile) files.add(configFile);
        for (const f of project.config.setupFiles) if (f !== SETUP_FILE) files.add(f);
        for (const f of [project.config.globalSetup ?? []].flat()) files.add(f);
      }
      return [...files].filter((f) => isAbsolute(f) && existsSync(f)).sort();
    },

    async testFiles() {
      return [...new Set((await vitest.globTestSpecifications()).map((s) => s.moduleId))].sort();
    },

    relatedTestFiles: (sources) => relatedTestFiles(vitest, sources, { root: options.root, setupFile: SETUP_FILE }),

    excludesTestFile(file) {
      return vitest.projects.some((project) => project.config.exclude.some((pattern) => matchesGlob(relative(project.config.root, file), pattern)));
    },

    async dryRun(files) {
      const all = await vitest.globTestSpecifications();
      // Match Vite's separators on Windows without collapsing `..`, which can change the target across symlinks.
      const testPathKey = (file: string) => process.platform === 'win32' ? file.replaceAll('\\', '/') : file;
      const wanted = files && new Set(files.map(testPathKey));
      const specs = wanted ? all.filter((s) => wanted.has(testPathKey(s.moduleId))) : all;
      const dry = specs.length > 0 ? collectDryRun(await run(null, DEFAULT_HIT_LIMIT, specs), options.root, vitest.projects.length > 1) : emptyDryRun();
      dry.deps = collectDeps(vitest, specs.map((s) => s.moduleId), options.root);
      for (const [id, location] of dry.index) locate(id, location);
      return dry;
    },

    useTestIndex(index) {
      locations.clear();
      byTask.clear();
      for (const [id, location] of index) locate(id, location);
    },

    async runMutant(key, testIds, { timeoutMs, stallMs, isStatic = false, hitLimit = DEFAULT_HIT_LIMIT, earlyExit = sessionEarlyExit }) {
      const byModule = new Map<string, { project: TestProject; moduleId: string; taskIds: string[] }>();
      for (const id of testIds) {
        const location = locations.get(id);
        if (!location) continue;
        const project = location.projectName === undefined ? vitest.getRootProject() : vitest.projects.find((p) => p.name === location.projectName);
        if (!project) continue;
        const groupKey = JSON.stringify([project.name, location.moduleId]);
        const group = byModule.get(groupKey) ?? { project, moduleId: location.moduleId, taskIds: [] };
        group.taskIds.push(location.taskId);
        byModule.set(groupKey, group);
      }
      const specs = [...byModule.values()].map(({ project, moduleId, taskIds }) =>
        project.createSpecification(moduleId, isStatic ? undefined : { testIds: taskIds }),
      );
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stall: ReturnType<typeof setTimeout> | undefined;
      let expire: (value: 'timeout') => void = () => {};
      const timeout = new Promise<'timeout'>((resolve) => {
        expire = resolve;
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const progress = () => {
        if (stallMs === undefined) return;
        clearTimeout(stall);
        stall = setTimeout(() => expire('timeout'), stallMs);
      };
      progress();
      const current = vitest;
      const currentWatch = watch;
      currentWatch.arm(earlyExit ? () => void current.cancelCurrentRun('test-failure') : () => {}, progress);
      const outcome = await Promise.race([run(key, hitLimit, specs, earlyExit), timeout]);
      clearTimeout(timer);
      clearTimeout(stall);
      const observed = currentWatch.disarm();
      const durationMs = performance.now() - started;
      if (outcome === 'timeout') {
        // A worker may be stuck in a synchronous loop; start over with a fresh instance.
        await closeQuietly(vitest);
        ({ vitest, watch } = await start(options, registry));
        await vitest.globTestSpecifications();
        return { status: 'Timeout', timeoutCause: 'time', killedBy: [], durationMs };
      }
      return { ...classifyRun(report(outcome, options.root, testIds, observed, idOf)), durationMs };
    },

    async close() {
      await closeQuietly(vitest);
    },
  };
}

async function start(options: SessionOptions, registry: MutantRegistry): Promise<{ vitest: Vitest; watch: FailureWatch }> {
  const runtime = resolveTestRuntime(options.root, options.configFile);
  const { createVitest } = await import(pathToFileURL(runtime.node).href) as typeof import('vitest/node');
  const watch = new FailureWatch();
  // Programmatic Vite plugins are not inherited by inline Vitest projects.
  // Each project needs fresh plugin instances attached before its Vite server starts.
  const plugins = (): Plugin[] => [
    {
      name: 'mutator:test-runtime',
      enforce: 'pre',
      config(config) {
        // Installed, the setup file lives under node_modules and would be externalized; Node would then
        // resolve its `vitest` import from this adapter's own peer, which may be another copy than the
        // project's (pnpm splits Vitest by peer variants). Inline it so `resolveId` below applies.
        const deps = ((config.test ??= {}).server ??= {}).deps ??= {};
        if (deps.inline !== true) deps.inline = [...(deps.inline ?? []), SETUP_ID];
      },
      resolveId(source, importer) {
        if (source !== 'vitest' || !importer || normalize(importer.split('?')[0]!) !== SETUP_FILE) return;
        return this.resolve(runtime.setup, runtime.importer, { skipSelf: true });
      },
    },
    mutatorPlugin(registry, options),
  ];
  const withPlugins = (project: UserWorkspaceConfig): UserWorkspaceConfig => ({ ...project, plugins: [...(project.plugins ?? []), ...plugins()] });
  const vitest = await createVitest(
    'test',
    {
      root: options.root,
      ...(options.configFile ? { config: options.configFile } : {}),
      watch: false,
      reporters: [watch],
      ...(options.maxWorkers ? { maxWorkers: options.maxWorkers } : {}),
      // bail is not used: vitest 5 may report a bailed run without its failed test.
      bail: 0,
      isolate: true,
      // Every session must run our transform hook to populate its own mutant registry.
      fsModuleCache: false,
      pool: options.pool ?? 'forks',
      includeTaskLocation: true,
      coverage: { enabled: false },
      onConsoleLog: () => false,
    },
    {
      plugins: [
        {
          name: 'mutator:projects',
          config(config) {
            if (!config.test?.projects) return;
            config.test.projects = config.test.projects.map((project) => {
              if (typeof project === 'string') return project;
              if (typeof project === 'function') return async (env) => withPlugins(await project(env));
              if (project instanceof Promise) return project.then(withPlugins);
              return withPlugins(project);
            });
          },
        },
        ...plugins(),
      ],
    },
  );
  vitest.provide('mutator', { active: null, hitLimit: DEFAULT_HIT_LIMIT, earlyExit: false });
  for (const project of vitest.projects) {
    project.config.setupFiles = [SETUP_FILE, ...project.config.setupFiles];
    project.config.fsModuleCache = false;
  }
  return { vitest, watch };
}

async function closeQuietly(vitest: Vitest): Promise<void> {
  const within = (ms: number, p: Promise<unknown> | undefined) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);
  // A worker stuck in a mutant's loop never answers the graceful stop request, so
  // `close()` alone leaves its thread spinning. Vitest's pool force-terminates
  // workers when a second close/cancel arrives while the first is still pending.
  const pool = (vitest as unknown as { pool?: { close?: () => Promise<void> } }).pool;
  if (pool?.close) {
    const first = pool.close();
    await within(2000, Promise.all([first, pool.close()]));
  }
  await within(2000, vitest.close());
}

function testId(root: string, test: TestCase, multiProject = false): string {
  return `${relative(root, test.module.moduleId)}#${multiProject ? `[${test.module.project.name}] ` : ''}${test.fullName}`;
}

function collectDryRun(result: TestRunResult, root: string, multiProject = false): DryRunResult {
  const tests: TestInfo[] = [];
  const coverage = new Map<string, string[]>();
  const hits = new Map<string, number>();
  const staticKeys = new Set<string>();
  const failed: string[] = [];
  const index = new Map<string, TestLocation>();
  const staticByFile = new Map<string, Set<string>>();
  const infected = new Map<string, string[]>();
  const spawns = new Map<string, SpawnedCommand[]>();
  const distinct = numberDuplicates();

  for (const module of result.testModules) {
    const moduleMeta = module.meta() as { mutatorStatic?: Record<string, number>; mutatorConcurrent?: Record<string, number>; mutatorConcurrentInfected?: Record<string, number>; mutatorConcurrentSpawns?: SpawnedCommand[]; mutatorCounts?: Record<string, number> };
    const moduleFile = relative(root, module.moduleId);
    const moduleStatic = staticByFile.get(moduleFile) ?? new Set<string>();
    staticByFile.set(moduleFile, moduleStatic);
    for (const key of Object.keys(moduleMeta.mutatorStatic ?? {})) {
      staticKeys.add(key);
      moduleStatic.add(key);
    }
    for (const [key, n] of Object.entries(moduleMeta.mutatorCounts ?? {})) hits.set(key, (hits.get(key) ?? 0) + n);
    if (module.errors().length > 0) {
      failed.push(relative(root, module.moduleId));
      for (const error of module.errors()) debug('%s: %s\n%s', module.moduleId, error.message, error.stack ?? '');
    }
    const fingerprint = hash(readFileSync(module.moduleId, 'utf8'));
    for (const test of module.children.allTests()) {
      const id = distinct(testId(root, test, multiProject));
      index.set(id, { moduleId: module.moduleId, taskId: test.id, ...(module.project.isRootProject() ? {} : { projectName: module.project.name }) });
      const state = test.result().state;
      if (state === 'skipped') continue;
      if (state === 'failed') failed.push(id);
      tests.push({ id, fingerprint: testFingerprint(fingerprint, id), durationMs: test.diagnostic()?.duration ?? 0 });
      const testHits = test.options.concurrent
        ? (moduleMeta.mutatorConcurrent ?? {})
        : ((test.meta() as { mutatorHits?: Record<string, number> }).mutatorHits ?? {});
      for (const key of Object.keys(testHits)) {
        const covering = coverage.get(key) ?? [];
        covering.push(id);
        coverage.set(key, covering);
      }
      const testInfected = test.options.concurrent
        ? (moduleMeta.mutatorConcurrentInfected ?? {})
        : ((test.meta() as { mutatorInfected?: Record<string, number> }).mutatorInfected ?? {});
      for (const key of Object.keys(testInfected)) infected.set(key, [...(infected.get(key) ?? []), id]);
      const spawned = test.options.concurrent ? moduleMeta.mutatorConcurrentSpawns : (test.meta() as { mutatorSpawns?: SpawnedCommand[] }).mutatorSpawns;
      if (spawned) spawns.set(id, spawned);
    }
  }
  for (const error of result.unhandledErrors) failed.push(String((error as Error)?.message ?? error));
  return { tests, coverage, staticKeys, failed, hits, index, staticByFile, deps: new Map(), infected, spawns };
}

/** The run as classifyRun reads it. */
function report(result: TestRunResult, root: string, testIds: readonly string[], observed: readonly TestCase[], idOf: (test: TestCase) => string): RunReport {
  const entry = (test: TestCase) => ({ id: idOf(test), failed: test.result().state === 'failed', messages: (test.result().errors ?? []).map((e) => e.message ?? '') });
  // A failure the watch observed counts even outside the selection: it cancelled the run
  // (a static mutant runs whole modules), and a cancelled run may report it as pending.
  const tests = observed.map((test) => ({ ...entry(test), failed: true }));
  const fileErrors: RunReport['fileErrors'][number][] = [];
  for (const module of result.testModules as readonly TestModule[]) {
    for (const error of module.errors()) fileErrors.push({ file: relative(root, module.moduleId), message: error.message ?? '' });
    for (const test of module.children.allTests()) tests.push(entry(test));
  }
  return {
    tests,
    fileErrors,
    runErrors: result.unhandledErrors.map((e) => (e as { message?: string }).message ?? String(e)),
    selected: new Set([...testIds, ...observed.map(idOf)]),
  };
}
