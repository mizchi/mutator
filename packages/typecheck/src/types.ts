import type { Range } from '@mizchi/mutator-core';

export interface TypecheckMutant {
  key: string;
  /** Absolute path of the mutated source. */
  file: string;
  range: Range;
  replacement: string;
}

export interface TypeChecker {
  /** `typescript` version of the project, e.g. `6.0.3` or `7.0.2`. */
  readonly version: string;
  /** Files and resolution directories consulted by the compiler (absolute paths). */
  readonly inputs: TypecheckInputs;
  /**
   * Mutants that introduce type errors in their own file (diagnostics already
   * present in the original source are ignored): key -> first new error.
   */
  check(mutants: readonly TypecheckMutant[]): Map<string, string>;
  /**
   * Mutants proven equivalent from the types of the original source: key -> reason
   * (`equivalent: ...`). Only `a?.b` -> `a.b` where `a` is never nullish; nothing
   * without strictNullChecks and noUncheckedIndexedAccess.
   */
  equivalent(mutants: readonly TypecheckMutant[]): Map<string, string>;
  close(): void;
}

export interface TypecheckInputs {
  files: string[];
  directories: string[];
  /** Replay these searches to notice newly included files, with the compiler's exact glob rules. */
  searches: TypecheckSearch[];
}

export interface TypecheckSearch {
  directory: string;
  extensions?: readonly string[];
  excludes?: readonly string[];
  includes?: readonly string[];
  depth?: number;
}

export interface CheckerOptions {
  root: string;
  /** Absolute path of the tsconfig to load. */
  tsconfig: string;
}
