// Contract layer of @mizchi/mutator-core.
// Everything here is plain serializable data; no runtime / fs / test-runner dependency.

export type MutatorName =
  | 'ArithmeticOperator'
  | 'ArrayDeclaration'
  | 'ArrowFunction'
  | 'AssignmentOperator'
  | 'BlockStatement'
  | 'BooleanLiteral'
  | 'CallExpression'
  | 'ConditionalExpression'
  | 'EqualityOperator'
  | 'FnValue'
  | 'LogicalOperator'
  | 'MethodExpression'
  | 'ObjectLiteral'
  | 'OptionalChaining'
  | 'Regex'
  | 'StringLiteral'
  | 'UnaryOperator'
  | 'UpdateOperator';

/** 1-based line, 0-based column (same convention as most editors / sourcemaps). */
export interface Position {
  line: number;
  column: number;
}

export interface Range {
  /** byte offset (UTF-16 code unit index into the source string) */
  start: number;
  end: number;
}

export interface Location {
  start: Position;
  end: Position;
}

/** The enclosing unit used for identity and cache invalidation. */
export interface Scope {
  /** Human readable, position independent path, e.g. `Foo.bar>inner` or `<top#3f2a>` */
  id: string;
  /** Hash of the scope's normalized source (comments / whitespace removed). */
  hash: string;
  range: Range;
  location: Location;
}

export interface Mutant {
  /**
   * Position independent identity. Also used as the runtime switch id.
   * hash(file, scope.id, astPath, mutator, replacement)
   */
  key: string;
  file: string;
  mutator: MutatorName;
  /** Region of the original source that is replaced. */
  range: Range;
  location: Location;
  original: string;
  replacement: string;
  scope: Scope;
  /** Set when the mutant was found but will not be placed (disabled comment, unplaceable, ...). */
  ignored?: string;
}

export interface SourceMapLike {
  version: number;
  sources: string[];
  names: string[];
  mappings: string;
  sourcesContent?: (string | null)[];
}

export interface InstrumentResult {
  code: string;
  map: SourceMapLike;
  mutants: Mutant[];
  /** Every scope of the file (functions and top-level statements), with or without mutants. */
  scopes: Scope[];
}

export interface InstrumentOptions {
  /** Restrict mutation to these source ranges (e.g. derived from a diff). */
  ranges?: readonly Range[];
  /** Mutators to exclude. */
  excludedMutators?: readonly MutatorName[];
  /**
   * Path used for mutant identity instead of `file` (e.g. relative to the project root),
   * so keys survive checkouts in different directories.
   */
  identity?: string;
}

// ---- results / cache --------------------------------------------------------

export type MutantStatus =
  | 'Killed'
  | 'Survived'
  | 'NoCoverage'
  | 'Timeout'
  | 'RuntimeError'
  | 'Ignored'
  /** Planned for execution but not run (e.g. outside --since); kept for its coverage, never reused. */
  | 'Pending';

export interface MutantResult {
  key: string;
  file: string;
  scopeId: string;
  scopeHash: string;
  status: MutantStatus;
  /** Tests that failed with this mutant active. */
  killedBy: string[];
  /** Tests that executed this mutant during the coverage run. */
  coveredBy: string[];
  durationMs?: number;
}

export interface TestInfo {
  id: string;
  /**
   * Opaque fingerprint supplied by the adapter: changes whenever the test body
   * or anything it depends on (that is not itself mutated) changes.
   */
  fingerprint: string;
  durationMs: number;
}

/** Persisted outcome of a previous run; the cache the planner reuses. */
export interface RunSnapshot {
  /** Tool / mutator-set version; a mismatch invalidates everything. */
  toolVersion: string;
  /** Hash of lockfile, tsconfig, runner config, node version ... supplied by the adapter. */
  envHash: string;
  results: MutantResult[];
  tests: TestInfo[];
}

export interface PlanOptions {
  timeoutFactor?: number;
  timeoutMs?: number;
}

export interface PlanInput {
  /** Mutants of the current source (including ignored ones). */
  mutants: readonly Mutant[];
  /** Tests known in the current run. */
  tests: readonly TestInfo[];
  /** Current per-test coverage: mutant key -> test ids. Undefined when coverage was not collected. */
  coverage: ReadonlyMap<string, readonly string[]> | undefined;
  /** Mutants hit while modules were loading (outside any test). */
  staticKeys: ReadonlySet<string>;
  previous: RunSnapshot | undefined;
  toolVersion: string;
  envHash: string;
  options?: PlanOptions;
}

export type PlanEntry =
  | { kind: 'ignored'; mutant: Mutant; reason: string }
  | { kind: 'reuse'; mutant: Mutant; result: MutantResult }
  | { kind: 'noCoverage'; mutant: Mutant }
  | {
      kind: 'run';
      mutant: Mutant;
      /** Ordered: likely killers first. */
      tests: string[];
      /** Static mutants need a fresh module graph and all tests. */
      isStatic: boolean;
      timeoutMs: number;
    };
