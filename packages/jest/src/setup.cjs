'use strict';
// Prepended to `setupFiles`: runs in each test file's environment before any
// module under test, so static (module-level) mutants already see the active key.
// Core's RUNTIME_GLOBAL and RuntimeState, written out: Jest requires this file into
// each test environment, where the ESM core cannot be loaded (test/worker.test.ts keeps them equal).
const limit = Number(process.env.MUTATOR_HIT_LIMIT);
globalThis.__mutator__ = {
  active: process.env.MUTATOR_ACTIVE || null,
  // Coverage is only needed by the dry run; mutant runs skip the counters entirely.
  collect: !process.env.MUTATOR_ACTIVE,
  modules: [],
  cov: { static: {}, perTest: {} },
  inf: { static: {}, perTest: {} },
  testId: null,
  hits: 0,
  hitLimit: Number.isFinite(limit) && limit > 0 ? limit : Infinity,
};
