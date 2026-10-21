'use strict';
// Prepended to `setupFilesAfterEnv`: attributes mutant hits to the running test
// and, in a dry run, writes the file's coverage for the session to collect.
const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

// Core's RUNTIME_GLOBAL, installed by setup.cjs.
const ns = globalThis.__mutator__;
// Duplicate full names get `#2`, `#3`, ... in execution (= declaration) order, like the session.
const seen = new Map();
// Test name -> processes it started (dry run only).
const spawns = {};

// Dry run only: record the processes each test starts (mutants applied in memory are not
// seen there). The builtin is shared by the worker's test files: each file re-wraps the original.
if (process.env.MUTATOR_COVERAGE_DIR) {
  const { resolve } = require('node:path');
  const { fileURLToPath } = require('node:url');
  const childProcess = require('node:child_process');
  const ORIGINAL = Symbol.for('mutator.original');
  const record = (name, [command, second, third]) => {
    if (ns.testId === null) return;
    try {
      const shell = name === 'exec' || name === 'execSync';
      const list = !shell && Array.isArray(second) ? second.map(String) : [];
      const options = shell || !Array.isArray(second) ? second : third;
      const argv = shell ? String(command).trim().split(/\s+/) : [...(name === 'fork' ? ['node'] : []), String(command), ...list];
      const cwd = options && typeof options === 'object' ? options.cwd : undefined;
      (spawns[ns.testId] ??= []).push({ argv, cwd: resolve(cwd instanceof URL ? fileURLToPath(cwd) : typeof cwd === 'string' ? cwd : process.cwd()) });
    } catch {
      // Recording must never break the test.
    }
  };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name][ORIGINAL] ?? childProcess[name];
    const wrap = (fn) =>
      function (...args) {
        record(name, args);
        return fn.apply(this, args);
      };
    const wrapped = wrap(original);
    wrapped[ORIGINAL] = original;
    // util.promisify.custom (exec, execFile)
    for (const key of Object.getOwnPropertySymbols(original)) wrapped[key] = typeof original[key] === 'function' ? wrap(original[key]) : original[key];
    childProcess[name] = wrapped;
  }
  require('node:module').syncBuiltinESMExports();
}

beforeEach(() => {
  const name = expect.getState().currentTestName ?? '';
  const n = (seen.get(name) ?? 0) + 1;
  seen.set(name, n);
  ns.testId = n > 1 ? `${name}#${n}` : name;
});

afterEach(() => {
  ns.testId = null;
});

afterAll(() => {
  const dir = process.env.MUTATOR_COVERAGE_DIR;
  if (!dir) return;
  const testPath = expect.getState().testPath;
  const name = createHash('sha256').update(testPath).digest('hex').slice(0, 32);
  const counts = {};
  for (const [keys, n] of ns.modules ?? []) for (let i = 0; i < keys.length; i++) if (n[i]) counts[keys[i]] = (counts[keys[i]] ?? 0) + n[i];
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ testPath, static: ns.cov.static, perTest: ns.cov.perTest, counts, spawns }));
});
