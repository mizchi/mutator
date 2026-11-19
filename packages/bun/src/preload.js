// Preloaded by `bun test --isolate --preload` in front of every test file, each in a fresh
// global: installs the runtime state, serves the session's instrumented sources through a
// runtime plugin, attributes mutant hits to the running test, and writes the file's record
// for the session to read. Plain JavaScript, because Bun loads it as is from published builds.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach } from 'bun:test';

const env = process.env;
const limit = Number(env.MUTATOR_HIT_LIMIT);
const active = env.MUTATOR_ACTIVE || null;

// Core's RUNTIME_GLOBAL and RuntimeState, written out (test/preload.test.ts keeps them equal).
// Set before any test file or source module loads, so static mutants see the active key.
const ns = {
  active,
  // Coverage is only needed by the dry run; mutant runs skip the counters entirely.
  collect: active === null,
  modules: [],
  cov: { static: {}, perTest: {} },
  inf: { static: {}, perTest: {} },
  testId: null,
  hits: 0,
  hitLimit: Number.isFinite(limit) && limit > 0 ? limit : Infinity,
};
globalThis.__mutator__ = ns;

// The session instruments the targets once and lists them in a manifest: `files` as
// [absolute source path, instrumented code path, Bun loader], and `filter`, the regex source
// matching those paths with either separator.
const manifest = env.MUTATOR_BUN_MANIFEST ? JSON.parse(readFileSync(env.MUTATOR_BUN_MANIFEST, 'utf8')) : { files: [] };
const served = new Map(manifest.files.map(([file, code, loader]) => [file, [code, loader]]));
if (served.size > 0) {
  const filter = new RegExp(manifest.filter);
  const lookup = (path) => served.get(path) ?? served.get(path.replaceAll('/', '\\')) ?? served.get(path.replaceAll('\\', '/'));
  Bun.plugin({
    name: 'mutator:instrument',
    setup(build) {
      // Synchronous: `require()` of a module whose onLoad returns a promise is unsupported.
      build.onLoad({ filter }, (args) => {
        const [code, loader] = lookup(args.path);
        return { contents: readFileSync(code, 'utf8'), loader };
      });
    },
  });
}

// Bun's hooks get no test context, so tests are numbered in the order they start: the
// session pairs the numbers with the tests its JUnit report lists, in declaration order.
// Overlapping tests (test.concurrent) or a count that does not match the report make the
// session credit the file's hits to every test of the file instead.
let started = 0;
let running = 0;
let overlap = false;

beforeEach(() => {
  if (running > 0) overlap = true;
  running++;
  ns.testId = String(started++);
});

afterEach(() => {
  running = Math.max(0, running - 1);
  if (running === 0) ns.testId = null;
});

// Dry run only: record the processes each test starts (mutants applied in memory are not
// seen there). node:child_process is implemented on Bun.spawn, so a call is recorded once.
const spawns = {};
if (ns.collect) {
  const ORIGINAL = Symbol.for('mutator.original');
  let inside = 0;
  const record = (argv, cwd) => {
    if (ns.testId === null) return;
    (spawns[ns.testId] ??= []).push({ argv: argv.map(String), cwd: resolve(cwd instanceof URL ? fileURLToPath(cwd) : typeof cwd === 'string' ? cwd : process.cwd()) });
  };
  const childProcess = createRequire(import.meta.url)('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name][ORIGINAL] ?? childProcess[name];
    const wrap = (fn) =>
      function (...args) {
        try {
          const [command, second, third] = args;
          const shell = name === 'exec' || name === 'execSync';
          const list = !shell && Array.isArray(second) ? second : [];
          const options = shell || !Array.isArray(second) ? second : third;
          const argv = shell ? String(command).trim().split(/\s+/) : [...(name === 'fork' ? ['node'] : []), command, ...list];
          record(argv, options && typeof options === 'object' ? options.cwd : undefined);
        } catch {
          // Recording must never break the test.
        }
        inside++;
        try {
          return fn.apply(this, args);
        } finally {
          inside--;
        }
      };
    const wrapped = wrap(original);
    wrapped[ORIGINAL] = original;
    // util.promisify.custom (exec, execFile)
    for (const key of Object.getOwnPropertySymbols(original)) wrapped[key] = typeof original[key] === 'function' ? wrap(original[key]) : original[key];
    childProcess[name] = wrapped;
  }
  // ESM named imports of node:child_process see the wrappers too.
  syncBuiltinESMExports();
  for (const name of ['spawn', 'spawnSync']) {
    const original = Bun[name][ORIGINAL] ?? Bun[name];
    const wrapped = function (...args) {
      if (inside === 0) {
        try {
          const [first, second] = args;
          const cmd = Array.isArray(first) ? first : first?.cmd;
          const options = Array.isArray(first) ? second : first;
          if (Array.isArray(cmd)) record(cmd, options?.cwd);
        } catch {
          // Recording must never break the test.
        }
      }
      return original.apply(this, args);
    };
    wrapped[ORIGINAL] = original;
    Bun[name] = wrapped;
  }
}

// Runs once the file's tests are done, also when the file failed to load (it then has no
// tests and is missing from the module registry). Not after --bail stopped the run.
afterAll(() => {
  const dir = env.MUTATOR_BUN_OUT;
  if (!dir) return;
  const file = Bun.main;
  const registry = createRequire(import.meta.url).cache;
  const record = { file, loaded: registry[file] !== undefined, tests: started, overlap, hitLimit: ns.hits > ns.hitLimit };
  if (ns.collect) {
    // Hits per mutant summed over the modules this file loaded (sizes hit limits).
    const counts = {};
    for (const [keys, n] of ns.modules) for (let i = 0; i < keys.length; i++) if (n[i]) counts[keys[i]] = (counts[keys[i]] ?? 0) + n[i];
    Object.assign(record, {
      static: ns.cov.static,
      perTest: ns.cov.perTest,
      infected: ns.inf.perTest,
      counts,
      spawns,
      // Local modules: the session reads them for test dependencies.
      modules: Object.keys(registry).filter((m) => isAbsolute(m) && !/[\\/]node_modules[\\/]/.test(m)),
    });
  }
  writeFileSync(join(dir, `${createHash('sha256').update(file).digest('hex').slice(0, 32)}.json`), JSON.stringify(record));
});
