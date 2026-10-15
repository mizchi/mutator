// Worker-side setup file injected in front of the project's setupFiles.
// Self-contained on purpose: it is evaluated inside the test worker.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnedCommand } from '@mizchi/mutator-core';
import { afterAll, afterEach, beforeEach, inject } from 'vitest';

import type {} from './provided.ts';

const config = inject('mutator');

// Assigned at module top level so mutants evaluated while importing the
// sources under test (static mutants) already see the active key.
const ns = {
  active: config.active,
  // Coverage is only needed by the dry run; mutant runs skip the counters entirely.
  collect: config.active === null,
  modules: [] as [readonly string[], ArrayLike<number>][],
  cov: { static: {} as Record<string, number>, perTest: {} as Record<string, Record<string, number>> },
  inf: { static: {} as Record<string, number>, perTest: {} as Record<string, Record<string, number>> },
  /** test id -> processes it started (dry run only) */
  spawns: {} as Record<string, SpawnedCommand[]>,
  testId: null as string | null,
  hits: 0,
  hitLimit: config.hitLimit,
};
(globalThis as Record<string, unknown>).__mutator__ = ns;

// Dry run only: record the processes each test starts. Mutants applied in memory are not
// seen there, so the CLI reports these tests and the code their commands may run.
const SPAWNERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
const ORIGINAL = Symbol.for('mutator.original');
type Fn = ((...args: unknown[]) => unknown) & Record<symbol, unknown>;

function recordSpawn(name: (typeof SPAWNERS)[number], args: unknown[]): void {
  // The module is patched once per process: look up the current file's state.
  const state = (globalThis as Record<string, unknown>).__mutator__ as typeof ns | undefined;
  if (!state?.collect || state.testId === null) return;
  try {
    const [command, second, third] = args;
    const shell = name === 'exec' || name === 'execSync';
    const list = !shell && Array.isArray(second) ? second.map(String) : [];
    const options = (shell || !Array.isArray(second) ? second : third) as { cwd?: unknown } | null | undefined;
    const argv = shell ? String(command).trim().split(/\s+/) : [...(name === 'fork' ? ['node'] : []), String(command), ...list];
    const cwd = options && typeof options === 'object' ? options.cwd : undefined;
    (state.spawns[state.testId] ??= []).push({ argv, cwd: resolve(cwd instanceof URL ? fileURLToPath(cwd) : typeof cwd === 'string' ? cwd : process.cwd()) });
  } catch {
    // Recording must never break the test.
  }
}

if (ns.collect) {
  const childProcess = createRequire(import.meta.url)('node:child_process') as Record<string, Fn>;
  for (const name of SPAWNERS) {
    // Re-wrap the original: a reused worker must not stack wrappers.
    const original = (childProcess[name]![ORIGINAL] ?? childProcess[name]) as Fn;
    const wrap = (fn: Fn) =>
      function (this: unknown, ...args: unknown[]) {
        recordSpawn(name, args);
        return fn.apply(this, args);
      } as Fn;
    const wrapped = wrap(original);
    wrapped[ORIGINAL] = original;
    // util.promisify.custom (exec, execFile)
    for (const key of Object.getOwnPropertySymbols(original)) {
      const value = original[key];
      wrapped[key] = typeof value === 'function' ? wrap(value as Fn) : value;
    }
    childProcess[name] = wrapped;
  }
  // ESM named imports of node:child_process see the wrappers too.
  syncBuiltinESMExports();
}

// Once a test fails under an active mutant it is killed: skip the rest of this
// file inside the worker (the main process can only cancel between files).
let killed = false;

// Concurrent tests interleave, so their hits share one bucket. It travels on the
// file's meta (reliably sent after afterAll) and the main process credits it to
// every concurrent test of the file.
const CONCURRENT = '\0concurrent';
let running = 0;

beforeEach(({ task, skip, onTestFailed }) => {
  if (killed) skip();
  if (task.concurrent) running++;
  ns.testId = task.concurrent ? CONCURRENT : task.id;
  if (config.active !== null && config.earlyExit) {
    onTestFailed(() => {
      killed = true;
    });
  }
});

afterEach(({ task }) => {
  if (task.concurrent) {
    if (--running === 0) ns.testId = null;
    return;
  }
  ns.testId = null;
  const hits = ns.cov.perTest[task.id];
  if (hits) (task.meta as Record<string, unknown>).mutatorHits = hits;
  const infected = ns.inf.perTest[task.id];
  if (infected) (task.meta as Record<string, unknown>).mutatorInfected = infected;
  const spawned = ns.spawns[task.id];
  if (spawned) (task.meta as Record<string, unknown>).mutatorSpawns = spawned;
});

// Vitest requires an object pattern for the first (fixture) argument.
// eslint-disable-next-line no-empty-pattern
afterAll(({}, suite) => {
  const meta = suite.meta as Record<string, unknown>;
  meta.mutatorStatic = ns.cov.static;
  // Hits per mutant summed over the modules this file loaded (sizes hit limits).
  const counts: Record<string, number> = {};
  for (const [keys, n] of ns.modules) for (let i = 0; i < keys.length; i++) if (n[i]) counts[keys[i]!] = (counts[keys[i]!] ?? 0) + n[i]!;
  meta.mutatorCounts = counts;
  const shared = ns.cov.perTest[CONCURRENT];
  if (shared) meta.mutatorConcurrent = shared;
  const sharedInfected = ns.inf.perTest[CONCURRENT];
  if (sharedInfected) meta.mutatorConcurrentInfected = sharedInfected;
  const sharedSpawns = ns.spawns[CONCURRENT];
  if (sharedSpawns) meta.mutatorConcurrentSpawns = sharedSpawns;
});
