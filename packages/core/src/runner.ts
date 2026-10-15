// Runner contract: what a test-runner adapter (Vitest, Jest, ...) implements so the
// CLI can orchestrate dry runs and mutant runs without knowing the runner, plus
// the small helpers every adapter needs to produce the same results.
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
  /** test id -> processes it started (runners that support it); mutants applied in memory are not seen there. */
  spawns?: Map<string, SpawnedCommand[]>;
}

/** A process a test started through `node:child_process`. */
export interface SpawnedCommand {
  /** The command and its arguments (a shell command line split on whitespace). */
  argv: string[];
  /** Working directory (absolute) the arguments are relative to. */
  cwd: string;
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
  /**
   * Stop at the first failing test (default: the session's setting, normally true). False
   * runs every selected test and reports all that fail (--kill-matrix).
   */
  earlyExit?: boolean;
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

/** Test ids are `<test file>#<full name>`: the test file part (relative to root). */
export const testFileOf = (testId: string): string => testId.slice(0, testId.indexOf('#'));

export function emptyDryRun(): DryRunResult {
  return { tests: [], coverage: new Map(), staticKeys: new Set(), failed: [], hits: new Map(), index: new Map(), staticByFile: new Map(), deps: new Map() };
}

/** Numbers repeated ids `#2`, `#3`, ... in encounter order, so tests sharing a full name stay distinct. */
export function numberDuplicates(): (id: string) => string {
  const seen = new Map<string, number>();
  return (id) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n > 1 ? `${id}#${n}` : id;
  };
}
