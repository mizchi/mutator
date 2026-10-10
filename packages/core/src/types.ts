// Contract layer of @mizchi/mutator-core.
// Plain data and plugin contracts; no runtime / fs / test-runner dependency.

export const BUILTIN_MUTATOR_NAMES = [
  'ArithmeticOperator',
  'ArrayDeclaration',
  'ArrowFunction',
  'AssignmentOperator',
  'BlockStatement',
  'BooleanLiteral',
  'CallExpression',
  'ConditionalExpression',
  'EqualityOperator',
  'FnValue',
  'LogicalOperator',
  'MethodExpression',
  'ObjectLiteral',
  'OptionalChaining',
  'Regex',
  'StringLiteral',
  'UnaryOperator',
  'UpdateOperator',
] as const;

export type BuiltinMutatorName = (typeof BUILTIN_MUTATOR_NAMES)[number];

/** Built-in names, or the name of a custom mutator from a plugin. */
export type MutatorName = BuiltinMutatorName | (string & {});

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
  /** Identifier names the scope's own code mentions (nested functions excluded). */
  refs?: string[];
  /** Top-level statements: the bindings they declare. */
  declares?: string[];
  /** Top-level statements: a declaration whose evaluation has no side effects. */
  pure?: boolean;
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
  /**
   * Weak-mutation checkable: the dry run records, per test, whether this mutant's
   * value would differ from the original's (infection). A test that never infects
   * cannot kill it.
   */
  weak?: boolean;
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
  /** Call sites by scope, with the callee as written (`f`, `obj.m`, `this.m`), for call graphs. */
  calls: CallSite[];
  /** Value imports of the file. */
  imports: ImportBinding[];
  /** Module specifiers re-exported with `export ... from`. */
  reexports: string[];
}

export interface CallSite {
  scope: string;
  callee: string;
}

export interface ImportBinding {
  local: string;
  /** Exported name, `default`, or `*` for namespace imports. */
  imported: string;
  source: string;
}

export interface InstrumentOptions {
  /** Restrict mutation to these source ranges (e.g. derived from a diff). */
  ranges?: readonly Range[];
  /** Mutators to exclude (built-in or custom names). */
  excludedMutators?: readonly MutatorName[];
  /** Custom mutators, run in addition to the built-in ones. */
  mutators?: readonly MutatorDefinition[];
  /** Weak-mutation probes in dry runs (default true): mutants no test infects are not run. */
  weak?: boolean;
  /** Mark every mutant under nodes they flag as ignored (like StrykerJS ignorers). */
  ignorers?: readonly MutantIgnorer[];
  /**
   * Arid node suppression: mutants in logging-only code are reported as ignored
   * (default on). `false` disables it; `callees` replaces the logging call patterns.
   */
  arid?: false | { callees?: readonly string[] };
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
  /** Does not type-check; never run, excluded from the score. */
  | 'CompileError'
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
  /** Static mutant key -> tests of the files that loaded it (default: every test). */
  staticTests?: ReadonlyMap<string, readonly string[]>;
  /**
   * Weak mutation data from the dry run: tests that infected each weak mutant, and
   * the tests whose infection was observed at all (others count as infecting).
   */
  infection?: { infected: ReadonlyMap<string, readonly string[]>; observed: ReadonlySet<string> };
  previous: RunSnapshot | undefined;
  toolVersion: string;
  envHash: string;
  options?: PlanOptions;
  /**
   * Experimental: whether a change in scope `changed` can affect mutants of scope
   * `mutant` (keys `${file}#${scopeId}`). When set, a test that ran changed code only
   * invalidates results of mutants in related scopes. Unsound for values passed
   * between functions through test code.
   */
  related?: (mutant: string, changed: string) => boolean;
}

export type PlanEntry =
  | { kind: 'ignored'; mutant: Mutant; reason: string }
  | { kind: 'reuse'; mutant: Mutant; result: MutantResult }
  | { kind: 'noCoverage'; mutant: Mutant }
  /** Covered, but no covering test reaches it with a different value: cannot be killed. */
  | { kind: 'notInfected'; mutant: Mutant }
  | {
      kind: 'run';
      mutant: Mutant;
      /** Ordered: likely killers first. */
      tests: string[];
      /** Static mutants need a fresh module graph and all tests. */
      isStatic: boolean;
      timeoutMs: number;
    };

// ---- plugins ----------------------------------------------------------------

/** An oxc ESTree node (TS-ESTree for TypeScript); type positions are never visited. */
export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: any;
}

export interface MutatorVisitContext {
  source: string;
  /** Parent node, and the property of the parent holding this node. */
  parent: AstNode | undefined;
  key: string;
  /** Source text of a node or range. */
  text(range: Range): string;
}

export interface MutationSpec {
  /** Text replacing `range` (default: the whole visited node). */
  replacement: string;
  /** Must lie inside the visited node. */
  range?: Range;
}

/**
 * A custom mutator. `visit` is called for every runtime node; placement
 * (mutation switching), identity, arid / disable handling are done by the engine.
 */
export interface MutatorDefinition {
  name: string;
  visit(node: AstNode, context: MutatorVisitContext): readonly MutationSpec[] | undefined | void;
}

/**
 * Ignores whole subtrees: when `shouldIgnore` returns a reason for a node, every
 * mutant under it is reported as ignored (`<name>: <reason>`) and never run.
 */
export interface MutantIgnorer {
  name: string;
  shouldIgnore(node: AstNode, context: MutatorVisitContext): string | undefined | void;
}

/** What a plugin module exports (default export): custom mutators, ignorers, logging-call patterns. */
export interface MutatorPlugin {
  name: string;
  mutators?: readonly MutatorDefinition[];
  ignorers?: readonly MutantIgnorer[];
  /** Extra arid (logging) callee patterns, e.g. `metrics.*`. */
  aridCallees?: readonly string[];
}
