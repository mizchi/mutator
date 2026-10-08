import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Mutant, type MutantStatus, type TestInfo, hash } from '@mizchi/mutator-core';
import type { TestCase, TestModule, TestRunResult, Vitest } from 'vitest/node';
import { createVitest } from 'vitest/node';
import { MutantRegistry, type PluginOptions, mutatorPlugin } from './plugin.ts';

const SETUP_FILE = fileURLToPath(new URL('./setup.ts', import.meta.url));
const DEFAULT_HIT_LIMIT = 1_000_000;

export interface SessionOptions extends PluginOptions {
  root: string;
  /** Path to a vitest config file; defaults to vitest's own lookup from `root`. */
  configFile?: string;
  /** Worker threads of this Vitest instance (sessions running mutants in parallel use 1 each). */
  maxWorkers?: number;
}

/** Where a test lives; task ids are deterministic so the index can be shared between sessions. */
export interface TestLocation {
  moduleId: string;
  taskId: string;
}

export interface DryRunResult {
  tests: TestInfo[];
  /** mutant key -> ids of tests that executed it */
  coverage: Map<string, string[]>;
  /** mutants executed while modules were loading */
  staticKeys: Set<string>;
  /** ids of tests (or modules) that failed without any mutant active */
  failed: string[];
  /** total hits per mutant, used to derive hit limits */
  hits: Map<string, number>;
  /** test id -> location, to hand to other sessions via `useTestIndex` */
  index: Map<string, TestLocation>;
  /** test file (relative to root) -> mutants hit while that file's modules were loading */
  staticByFile: Map<string, Set<string>>;
}

export interface RunMutantOptions {
  timeoutMs: number;
  isStatic?: boolean;
  hitLimit?: number;
}

export interface MutantRunResult {
  status: Extract<MutantStatus, 'Killed' | 'Survived' | 'Timeout' | 'RuntimeError'>;
  killedBy: string[];
  durationMs: number;
}

export interface Session {
  mutants(): Mutant[];
  /** Absolute paths of the project's test files. */
  testFiles(): Promise<string[]>;
  /** Run tests without mutants (optionally only the given test files) and collect coverage. */
  dryRun(files?: readonly string[]): Promise<DryRunResult>;
  runMutant(key: string, testIds: readonly string[], options: RunMutantOptions): Promise<MutantRunResult>;
  /** Reuse the test index of another session's dry run instead of running one. */
  useTestIndex(index: ReadonlyMap<string, TestLocation>): void;
  close(): Promise<void>;
}

export async function createSession(options: SessionOptions): Promise<Session> {
  const registry = new MutantRegistry();
  let vitest = await start(options, registry);
  const locations = new Map<string, TestLocation>();

  const run = async (active: string | null, hitLimit: number, specs: Parameters<Vitest['runTestSpecifications']>[0]) => {
    vitest.provide('mutator', { active, hitLimit });
    return vitest.runTestSpecifications(specs);
  };

  return {
    mutants: () => registry.all(),

    async testFiles() {
      return [...new Set((await vitest.globTestSpecifications()).map((s) => s.moduleId))].sort();
    },

    async dryRun(files) {
      const all = await vitest.globTestSpecifications();
      const wanted = files && new Set(files);
      const specs = wanted ? all.filter((s) => wanted.has(s.moduleId)) : all;
      const dry = specs.length > 0 ? collectDryRun(await run(null, DEFAULT_HIT_LIMIT, specs), options.root) : emptyDryRun();
      for (const [id, location] of dry.index) locations.set(id, location);
      return dry;
    },

    useTestIndex(index) {
      locations.clear();
      for (const [id, location] of index) locations.set(id, location);
    },

    async runMutant(key, testIds, { timeoutMs, isStatic = false, hitLimit = DEFAULT_HIT_LIMIT }) {
      const byModule = new Map<string, string[]>();
      for (const id of testIds) {
        const location = locations.get(id);
        if (!location) continue;
        const ids = byModule.get(location.moduleId) ?? [];
        ids.push(location.taskId);
        byModule.set(location.moduleId, ids);
      }
      const project = vitest.getRootProject();
      const specs = [...byModule].map(([moduleId, taskIds]) =>
        project.createSpecification(moduleId, isStatic ? undefined : { testIds: taskIds }),
      );
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const outcome = await Promise.race([run(key, hitLimit, specs), timeout]);
      clearTimeout(timer);
      const durationMs = performance.now() - started;
      if (outcome === 'timeout') {
        // A worker may be stuck in a synchronous loop; start over with a fresh instance.
        await closeQuietly(vitest);
        vitest = await start(options, registry);
        await vitest.globTestSpecifications();
        return { status: 'Timeout', killedBy: [], durationMs };
      }
      return { ...classify(outcome, options.root, new Set(testIds)), durationMs };
    },

    async close() {
      await closeQuietly(vitest);
    },
  };
}

async function start(options: SessionOptions, registry: MutantRegistry): Promise<Vitest> {
  const vitest = await createVitest(
    'test',
    {
      root: options.root,
      ...(options.configFile ? { config: options.configFile } : {}),
      watch: false,
      reporters: [],
      ...(options.maxWorkers ? { maxWorkers: options.maxWorkers } : {}),
      bail: 1,
      isolate: true,
      includeTaskLocation: true,
      coverage: { enabled: false },
      onConsoleLog: () => false,
    },
    { plugins: [mutatorPlugin(registry, options)] },
  );
  vitest.provide('mutator', { active: null, hitLimit: DEFAULT_HIT_LIMIT });
  for (const project of vitest.projects) {
    project.config.setupFiles = [SETUP_FILE, ...project.config.setupFiles];
  }
  return vitest;
}

async function closeQuietly(vitest: Vitest): Promise<void> {
  await Promise.race([vitest.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))]);
}

function testId(root: string, test: TestCase): string {
  return `${relative(root, test.module.moduleId)}#${test.fullName}`;
}

function emptyDryRun(): DryRunResult {
  return { tests: [], coverage: new Map(), staticKeys: new Set(), failed: [], hits: new Map(), index: new Map(), staticByFile: new Map() };
}

function collectDryRun(result: TestRunResult, root: string): DryRunResult {
  const tests: TestInfo[] = [];
  const coverage = new Map<string, string[]>();
  const hits = new Map<string, number>();
  const staticKeys = new Set<string>();
  const failed: string[] = [];
  const index = new Map<string, TestLocation>();
  const staticByFile = new Map<string, Set<string>>();
  const seen = new Map<string, number>();

  for (const module of result.testModules) {
    const moduleMeta = module.meta() as { mutatorStatic?: Record<string, number> };
    const moduleStatic = new Set<string>();
    staticByFile.set(relative(root, module.moduleId), moduleStatic);
    for (const [key, n] of Object.entries(moduleMeta.mutatorStatic ?? {})) {
      staticKeys.add(key);
      moduleStatic.add(key);
      hits.set(key, (hits.get(key) ?? 0) + n);
    }
    if (module.errors().length > 0) failed.push(relative(root, module.moduleId));
    const fingerprint = hash(readFileSync(module.moduleId, 'utf8'));
    for (const test of module.children.allTests()) {
      let id = testId(root, test);
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      if (n > 1) id = `${id}#${n}`;
      index.set(id, { moduleId: module.moduleId, taskId: test.id });
      const state = test.result().state;
      if (state === 'skipped') continue;
      if (state === 'failed') failed.push(id);
      tests.push({ id, fingerprint: hash(`${fingerprint}\0${id}`), durationMs: test.diagnostic()?.duration ?? 0 });
      const testHits = (test.meta() as { mutatorHits?: Record<string, number> }).mutatorHits ?? {};
      for (const [key, count] of Object.entries(testHits)) {
        const covering = coverage.get(key) ?? [];
        covering.push(id);
        coverage.set(key, covering);
        hits.set(key, (hits.get(key) ?? 0) + count);
      }
    }
  }
  for (const error of result.unhandledErrors) failed.push(String((error as Error)?.message ?? error));
  return { tests, coverage, staticKeys, failed, hits, index, staticByFile };
}

function classify(result: TestRunResult, root: string, selected: ReadonlySet<string>): Omit<MutantRunResult, 'durationMs'> {
  const killedBy: string[] = [];
  let moduleError = false;
  for (const module of result.testModules as readonly TestModule[]) {
    if (module.errors().length > 0) {
      moduleError = true;
      killedBy.push(relative(root, module.moduleId));
    }
    for (const test of module.children.allTests()) {
      const id = testId(root, test);
      if (test.result().state === 'failed' && (selected.size === 0 || selected.has(id) || [...selected].some((s) => s.startsWith(`${id}#`)))) {
        killedBy.push(id);
      }
    }
  }
  if (result.unhandledErrors.length > 0 && killedBy.length === 0) return { status: 'RuntimeError', killedBy: [] };
  if (killedBy.length > 0) return { status: moduleError && killedBy.every((k) => !k.includes('#')) ? 'RuntimeError' : 'Killed', killedBy };
  return { status: 'Survived', killedBy };
}
