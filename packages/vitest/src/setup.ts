// Worker-side setup file injected in front of the project's setupFiles.
// Self-contained on purpose: it is evaluated inside the test worker.
import { constants } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RUNTIME_GLOBAL, RuntimeState, SpawnedCommand } from '@mizchi/mutator-core';
import { afterAll, afterEach, beforeEach, inject } from 'vitest';

import type {} from './provided.ts';

const config = inject('mutator');
// Typed against core's constant, not imported from it: core may itself be a mutation target.
const GLOBAL: typeof RUNTIME_GLOBAL = '__mutator__';

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
  /** Absolute paths this file read through `node:fs` (dry run only) */
  reads: new Set<string>(),
  /** Environment variables this file read; `*` when it listed them (dry run only) */
  env: new Set<string>(),
  testId: null as string | null,
  hits: 0,
  hitLimit: config.hitLimit,
} satisfies Required<RuntimeState> & { spawns: Record<string, SpawnedCommand[]>; reads: Set<string>; env: Set<string> };
(globalThis as Record<string, unknown>)[GLOBAL] = ns;

// Dry run only: record the processes each test starts. Mutants applied in memory are not
// seen there, so the CLI reports these tests and the code their commands may run.
const SPAWNERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
const ORIGINAL = Symbol.for('mutator.original');
type Fn = ((...args: unknown[]) => unknown) & Record<symbol, unknown>;

function recordSpawn(name: (typeof SPAWNERS)[number], args: unknown[]): void {
  // The module is patched once per process: look up the current file's state.
  const state = (globalThis as Record<string, unknown>)[GLOBAL] as typeof ns | undefined;
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
  // ESM named imports of node:child_process see the wrappers too. Runtimes that only
  // emulate Node (workerd under @cloudflare/vitest-pool-workers) export the function
  // but throw from it: they start no processes, so there is nothing to record.
  try {
    syncBuiltinESMExports();
  } catch {
    // Not Node: spawns go unrecorded.
  }
}

// Dry run only: record the files and environment variables each test file reads, so
// the CLI keys its cached verdicts on them. Like the spawn wrappers, these are installed
// once per process and record into the state of the file running now.
function currentState(): typeof ns | undefined {
  const state = (globalThis as Record<string, unknown>)[GLOBAL] as typeof ns | undefined;
  return state?.collect ? state : undefined;
}

/** `node:fs` functions whose first argument is a path they read (with their `Sync` forms). */
const FS_READERS = ['readFile', 'readdir', 'opendir', 'stat', 'lstat', 'access', 'exists', 'open', 'createReadStream'] as const;
const WRITE_FLAGS = /[wa]/;
let reentrant = false;

function recordRead(name: string, args: unknown[]): void {
  const state = currentState();
  if (!state || reentrant) return;
  try {
    const [target, flags] = args;
    if (name.startsWith('open') && !name.startsWith('opendir')) {
      // `r+` reads; flags that create, empty or append to the file write.
      if (typeof flags === 'string' && WRITE_FLAGS.test(flags)) return;
      if (typeof flags === 'number' && flags & (constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_TRUNC)) return;
    }
    const path = target instanceof URL ? (target.protocol === 'file:' ? fileURLToPath(target) : undefined)
      : typeof target === 'string' ? target
        : target instanceof Uint8Array ? Buffer.from(target).toString()
          : undefined;
    if (path === undefined) return;
    const file = resolve(path);
    // The CLI keeps only paths inside the project root; skip the obvious rest here.
    if (/[/\\](?:node_modules|\.mutator)(?:[/\\]|$)/.test(file)) return;
    state.reads.add(file);
  } catch {
    // Recording must never break the test.
  }
}

function trackFileReads(): void {
  const require = createRequire(import.meta.url);
  const targets = [require('node:fs'), require('node:fs/promises')] as Record<string, Fn>[];
  for (const target of targets) {
    for (const name of FS_READERS.flatMap((n) => [n, `${n}Sync`])) {
      const current = target[name];
      if (typeof current !== 'function') continue;
      const original = (current[ORIGINAL] ?? current) as Fn;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        recordRead(name, args);
        if (reentrant) return original.apply(this, args);
        // A wrapped call reads only its own path, not the ones Node reads on the way.
        reentrant = true;
        try {
          return original.apply(this, args);
        } finally {
          reentrant = false;
        }
      } as Fn;
      wrapped[ORIGINAL] = original;
      for (const key of Object.getOwnPropertySymbols(original)) if (key !== ORIGINAL) wrapped[key] = original[key];
      Object.defineProperty(wrapped, 'length', { value: original.length });
      target[name] = wrapped;
    }
  }
  try {
    syncBuiltinESMExports();
  } catch {
    // Not Node: reads go unrecorded.
  }
}

const ENV_PROXY = Symbol.for('mutator.env');
/** Read by Node's module loader while it loads a module, not by the test. */
const LOADER_VARIABLES = new Set(['WATCH_REPORT_DEPENDENCIES', 'NODE_V8_COVERAGE']);

/**
 * Put a proxy in front of `process.env` that records the names read. Listing the
 * variables (spreading, `Object.keys`, passing them to a child process) records `*`;
 * the per-name lookups of that same listing are not recorded on top.
 */
function trackEnvironment(): void {
  const env = process.env as NodeJS.ProcessEnv & { [ENV_PROXY]?: true };
  if (env[ENV_PROXY]) return;
  let listing = false;
  const record = (name: string | symbol) => {
    if (typeof name !== 'string' || listing || LOADER_VARIABLES.has(name)) return;
    currentState()?.env.add(name);
  };
  process.env = new Proxy(env, {
    get(target, name) {
      if (name === ENV_PROXY) return true;
      record(name);
      return Reflect.get(target, name);
    },
    has(target, name) {
      record(name);
      return Reflect.has(target, name);
    },
    getOwnPropertyDescriptor(target, name) {
      record(name);
      return Reflect.getOwnPropertyDescriptor(target, name);
    },
    // Writes go to the real object with itself as the receiver. The default [[Set]] would
    // define the property on the proxy with a bare `{ value }` descriptor, which process.env
    // rejects for a variable that already exists.
    set(target, name, value) {
      return Reflect.set(target, name, value);
    },
    defineProperty(target, name, descriptor) {
      return Reflect.defineProperty(target, name, descriptor);
    },
    ownKeys(target) {
      const state = currentState();
      if (state) {
        state.env.add('*');
        listing = true;
        queueMicrotask(() => {
          listing = false;
        });
      }
      return Reflect.ownKeys(target);
    },
  });
}

if (ns.collect) {
  trackFileReads();
  trackEnvironment();
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
  if (ns.reads.size) meta.mutatorReads = [...ns.reads];
  if (ns.env.size) meta.mutatorEnv = [...ns.env];
});
