'use strict';
// Prepended to `setupFilesAfterEnv`: attributes mutant hits to the running test
// and, in a dry run, writes the file's coverage for the session to collect.
const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const ns = globalThis.__mutator__;
// Duplicate full names get `#2`, `#3`, ... in execution (= declaration) order, like the session.
const seen = new Map();

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
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ testPath, static: ns.cov.static, perTest: ns.cov.perTest, counts }));
});
