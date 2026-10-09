// Worker-side setup file injected in front of the project's setupFiles.
// Self-contained on purpose: it is evaluated inside the test worker.
import { afterAll, afterEach, beforeEach, inject } from 'vitest';

import type {} from './provided.ts';

const config = inject('mutator');

// Assigned at module top level so mutants evaluated while importing the
// sources under test (static mutants) already see the active key.
const ns = {
  active: config.active,
  cov: { static: {} as Record<string, number>, perTest: {} as Record<string, Record<string, number>> },
  testId: null as string | null,
  hits: 0,
  hitLimit: config.hitLimit,
};
(globalThis as Record<string, unknown>).__mutator__ = ns;

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
});

// Vitest requires an object pattern for the first (fixture) argument.
// eslint-disable-next-line no-empty-pattern
afterAll(({}, suite) => {
  const meta = suite.meta as Record<string, unknown>;
  meta.mutatorStatic = ns.cov.static;
  meta.mutatorTotalHits = ns.hits;
  const shared = ns.cov.perTest[CONCURRENT];
  if (shared) meta.mutatorConcurrent = shared;
});
