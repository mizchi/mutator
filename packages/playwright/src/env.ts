// What the processes share: the CLI (session), the dev server (Vite plugin), the Playwright
// runner (generated config, reporter) and its workers (fixture). The paths travel in
// environment variables, set once when each process starts; what changes per run is in the
// run file, written before each run.
import type { InstrumentOptions } from '@mizchi/mutator-core';

/** Path of the Settings file; the dev server instruments only when it is set. */
export const SETTINGS_ENV = 'MUTATOR_PLAYWRIGHT';
/** Path of the run file (RunConfig as JSON). */
export const RUN_FILE_ENV = 'MUTATOR_PLAYWRIGHT_RUN_FILE';

/** How the dev server instruments, so its mutant keys match the CLI's. */
export interface Settings extends Pick<InstrumentOptions, 'arid' | 'excludedMutators' | 'weak'> {
  root: string;
  /** Absolute paths of the files to instrument. */
  targets: string[];
  /** Absolute paths of the plugin modules providing custom mutators / ignorers. */
  pluginModules: string[];
}

/** One run: which mutant is active, and where the fixture and the reporter write. */
export interface RunConfig {
  /** Key of the active mutant; null for the dry run (which collects coverage). */
  active: string | null;
  hitLimit: number;
  /** Directory for the per-worker JSONL coverage files (dry run only). */
  out?: string;
  /** Upper bound of `expect` timeouts (ms), applied by the generated config. */
  expectTimeout?: number;
  /** Where the reporter writes the RunResults. */
  results: string;
}

/** A test as the reporter saw it run. */
export interface TestOutcome {
  /** Absolute path of the test file. */
  file: string;
  line: number;
  project: string;
  /** Describe blocks and the test title. */
  titles: string[];
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  durationMs: number;
}

/** What the reporter writes at the end of a run. */
export interface RunResults {
  tests: TestOutcome[];
  /** Errors outside any test (a test file failing to load, a global setup). */
  errors: string[];
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
