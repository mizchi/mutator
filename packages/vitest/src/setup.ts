// Worker-side setup file injected in front of the project's setupFiles.
// Self-contained on purpose: it is evaluated inside the test worker.
import { afterAll, afterEach, beforeEach, inject } from 'vitest';

declare module 'vitest' {
  interface ProvidedContext {
    mutator: { active: string | null; hitLimit: number; earlyExit: boolean };
  }
}

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

beforeEach(({ task, skip, onTestFailed }) => {
  if (killed) skip();
  ns.testId = task.id;
  if (config.active !== null && config.earlyExit) {
    onTestFailed(() => {
      killed = true;
    });
  }
});

afterEach(({ task }) => {
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
});
