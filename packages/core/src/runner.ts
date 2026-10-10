// Runner contract: what a test-runner adapter (Vitest, Jest, ...) implements so the
// CLI can orchestrate dry runs and mutant runs without knowing the runner. Types only.
import type { Mutant, MutantStatus, TestInfo } from './types.ts';

/** Where a test lives; task ids are deterministic so the index can be shared between sessions. */
export interface TestLocation {
  moduleId: string;
  taskId: string;
}

export interface DryRunResult {
  tests: TestInfo[];
  /** mutant key -> ids of tests that executed it */
  coverage: Map<string, string[]>;
  /** mutants executed while modules were loading */
  staticKeys: Set<string>;
  /** ids of tests (or modules) that failed without any mutant active */
  failed: string[];
  /** total hits per mutant, used to derive hit limits */
  hits: Map<string, number>;
  /** test id -> location, to hand to other sessions via `useTestIndex` */
  index: Map<string, TestLocation>;
  /** test file (relative to root) -> mutants hit while that file's modules were loading */
  staticByFile: Map<string, Set<string>>;
  /** test file (relative) -> local files it imports, transitively (relative, sorted), excluding node_modules */
  deps: Map<string, string[]>;
  /** Weak mutation: mutant key -> tests that reached it with a different value (runners that support it). */
  infected?: Map<string, string[]>;
}

export interface RunMutantOptions {
  /** Budget for the whole run. */
  timeoutMs: number;
  /**
   * Budget between two progress signals (a test starting or finishing). A mutant
   * stuck in a loop stops making progress long before the total budget runs out.
   * Runners that cannot observe progress ignore it.
   */
  stallMs?: number;
  isStatic?: boolean;
  hitLimit?: number;
}

export interface MutantRunResult {
  status: Extract<MutantStatus, 'Killed' | 'Survived' | 'Timeout' | 'RuntimeError'>;
  killedBy: string[];
  durationMs: number;
}

/** A test-runner session: what the CLI drives. Implemented by @mizchi/mutator-vitest and @mizchi/mutator-jest. */
export interface Session {
  mutants(): Mutant[];
  /** Absolute paths of the project's test files. */
  testFiles(): Promise<string[]>;
  /** Files every test depends on: resolved config files, setupFiles and globalSetup (absolute). */
  configFiles(): string[];
  /** Run tests without mutants (optionally only the given test files) and collect coverage. */
  dryRun(files?: readonly string[]): Promise<DryRunResult>;
  runMutant(key: string, testIds: readonly string[], options: RunMutantOptions): Promise<MutantRunResult>;
  /** Reuse the test index of another session's dry run instead of running one. */
  useTestIndex(index: ReadonlyMap<string, TestLocation>): void;
  close(): Promise<void>;
}
