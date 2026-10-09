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
  /**
   * Mutants that introduce type errors in their own file (diagnostics already
   * present in the original source are ignored): key -> first new error.
   */
  check(mutants: readonly TypecheckMutant[]): Map<string, string>;
  close(): void;
}

export interface CheckerOptions {
  root: string;
  /** Absolute path of the tsconfig to load. */
  tsconfig: string;
}
