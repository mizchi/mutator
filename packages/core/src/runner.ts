// Runner contract: what a test-runner adapter (Vitest, Jest, ...) implements so the
// CLI can orchestrate dry runs and mutant runs without knowing the runner, plus
// the small helpers every adapter needs to produce the same results.
import { hash } from './hash.ts';
import type { InstrumentOptions, Mutant, MutantStatus, TestInfo } from './types.ts';

/** Where a test lives; task ids are deterministic so the index can be shared between sessions. */
export interface TestLocation {
  moduleId: string;
  taskId: string;
  /** Runner project owning this specification; absent in older single-project indexes. */
  projectName?: string;
}

export interface DryRunResult {
  tests: TestInfo[];
  /** mutant key -> ids of tests that executed it */
  coverage: Map<string, string[]>;
  /** mutants executed while modules were loading */
  staticKeys: Set<string>;
  /** ids of tests (or modules) that failed without any mutant active */
  failed: string[];
  /** id in `failed` -> its first error (message, then the first stack frame when known), for the baseline error. */
  failures?: Map<string, string>;
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
  /** Original source function scope (`relative file#scopeId`) -> tests that executed it. */
  sourceCoverage?: Map<string, string[]>;
  /** Tests whose source coverage may be missing (navigation, closed pages, missing maps). */
  sourceCoverageIncomplete?: Set<string>;
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
  /**
   * Why a run is a Timeout. `hitLimit`: instrumented code exceeded its hit limit, which proves
   * a loop. `time`: the wall-clock or stall budget ran out, which a slow (busy) machine can also cause.
   */
  timeoutCause?: 'hitLimit' | 'time';
}

/** A test-runner session: what the CLI drives. Implemented by @mizchi/mutator-vitest and @mizchi/mutator-jest. */
export interface Session {
  mutants(): Mutant[];
  /** Absolute paths of the project's test files. */
  testFiles(): Promise<string[]>;
  /**
   * Tests importing these sources, for a cold run with an explicit include set.
   * Undefined means the runner cannot safely narrow the dependency graph.
   */
  relatedTestFiles?(sources: readonly string[]): Promise<string[] | undefined>;
  /**
   * Whether the runner's config excludes this test file (absolute) on purpose, so not collecting
   * it is no mistake. Optional: without it every uncollected test file is reported.
   */
  excludesTestFile?(file: string): boolean;
  /** Files every test depends on: resolved config files, setupFiles and globalSetup (absolute). */
  configFiles(): string[];
  /** Run tests without mutants (optionally only the given test files) and collect coverage. */
  dryRun(files?: readonly string[]): Promise<DryRunResult>;
  runMutant(key: string, testIds: readonly string[], options: RunMutantOptions): Promise<MutantRunResult>;
  /** Reuse the test index of another session's dry run instead of running one. */
  useTestIndex(index: ReadonlyMap<string, TestLocation>): void;
  close(): Promise<void>;
}

/**
 * A session cannot start because of the project's setup (a config the runner cannot load, a dev
 * server that fails or a port in use), not because of a bug: the CLI prints the message alone.
 */
export class RunnerSetupError extends Error {}

/** Test ids are `<test file>#<full name>`; relative file keys use `/` on every OS. */
export const testFileOf = (testId: string): string => testId.slice(0, testId.indexOf('#'));

export function emptyDryRun(): DryRunResult {
  return { tests: [], coverage: new Map(), staticKeys: new Set(), failed: [], hits: new Map(), index: new Map(), staticByFile: new Map(), deps: new Map() };
}

/**
 * An error as the baseline report shows it: the message, then the first stack frame below it
 * (when the message does not already carry one). The CLI trims and bounds it.
 */
export function describeError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const { message, stack, name } = error as { message?: unknown; stack?: unknown; name?: unknown };
  const text = typeof message === 'string' ? (typeof name === 'string' && name && !message.startsWith(name) ? `${name}: ${message}` : message) : String(error);
  if (/^\s+at /m.test(text) || typeof stack !== 'string') return text;
  const frame = stack.split('\n').find((line) => /^\s+at /.test(line));
  return frame ? `${text}\n${frame.trim()}` : text;
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

/**
 * A test's fingerprint: changes when its test file (or what the file imports) changes. Adapters
 * and the CLI must compute it the same way, or cached results are never reused.
 */
export const testFingerprint = (testFileHash: string, testId: string): string => hash(`${testFileHash}\0${testId}`);

/** The instrument options an adapter passes through to `instrument`. */
export type InstrumentFlags = Pick<InstrumentOptions, 'arid' | 'excludedMutators' | 'weak' | 'mutators' | 'ignorers'>;

const FLAG_KEYS = ['arid', 'excludedMutators', 'weak', 'mutators', 'ignorers'] as const satisfies readonly (keyof InstrumentFlags)[];

/** The instrument options among `options` that are set (an option left undefined is left out). */
export function instrumentFlags(options: { readonly [K in keyof InstrumentFlags]?: InstrumentFlags[K] | undefined }): InstrumentFlags {
  return Object.fromEntries(FLAG_KEYS.filter((k) => options[k] !== undefined).map((k) => [k, options[k]])) as InstrumentFlags;
}

/** The instrument options that survive JSON: what a session hands a runner in another process (plugins go as module paths). */
export type PortableFlags = Pick<InstrumentFlags, 'arid' | 'excludedMutators' | 'weak'>;

/** The portable instrument options among `options` that are set. */
export function portableFlags(options: { readonly [K in keyof InstrumentFlags]?: InstrumentFlags[K] | undefined }): PortableFlags {
  const { mutators: _mutators, ignorers: _ignorers, ...portable } = instrumentFlags(options);
  return portable;
}
