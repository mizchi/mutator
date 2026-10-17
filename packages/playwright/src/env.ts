// What the three processes share: the CLI (session), the dev server (Vite plugin) and the
// Playwright workers (fixture). Each reads its part from an environment variable.
import type { InstrumentOptions } from '@mizchi/mutator-core';

/** Path of the Settings file; the dev server instruments only when it is set. */
export const SETTINGS_ENV = 'MUTATOR_PLAYWRIGHT';
/** RunConfig as JSON, for the fixture in the Playwright workers. */
export const RUN_ENV = 'MUTATOR_PLAYWRIGHT_RUN';
/** Upper bound of `expect` timeouts in mutant runs (ms), read by the generated config. */
export const EXPECT_TIMEOUT_ENV = 'MUTATOR_PLAYWRIGHT_EXPECT_TIMEOUT';

/** How the dev server instruments, so its mutant keys match the CLI's. */
export interface Settings extends Pick<InstrumentOptions, 'arid' | 'excludedMutators' | 'weak'> {
  root: string;
  /** Absolute paths of the files to instrument. */
  targets: string[];
  /** Absolute paths of the plugin modules providing custom mutators / ignorers. */
  pluginModules: string[];
}

/** One run: which mutant is active, and where the fixture writes what it observed. */
export interface RunConfig {
  /** Key of the active mutant; null for the dry run (which collects coverage). */
  active: string | null;
  hitLimit: number;
  /** Directory for the per-worker JSONL coverage files (dry run only). */
  out?: string;
}

/** What the fixture records per test (dry run). */
export interface TestRecord {
  /** Absolute path of the test file. */
  file: string;
  project: string;
  /** Describe blocks and the test title. */
  titles: string[];
  /** Mutants the test reached, from every page of its context. */
  hits: Record<string, number>;
  /** Weak mutation: mutants it reached with a different value. */
  infected: Record<string, number>;
  /** Hits per mutant, summed (sizes hit limits). */
  counts: Record<string, number>;
}
