// Kill matrix analysis (--kill-matrix): which tests detect nothing mutation can observe,
// and which add no detection power over another single test. Pure functions over results.
import type { MutantStatus, ResultReason } from '@mizchi/mutator-core';

/** The part of a result (or report entry) the analysis reads. */
export interface MatrixRow {
  key: string;
  status: MutantStatus;
  killedBy: readonly string[];
  coveredBy: readonly string[];
  /** Killed by a run without early exit: `killedBy` lists every covering test that fails. */
  matrix?: boolean;
  reason?: ResultReason;
}

export interface KillMatrixAnalysis {
  /**
   * full: mutants whose kill set is complete (the analysis is computed over these only);
   * timeout: covered mutants that timed out; incomplete: other covered mutants without a
   * complete kill set (killed with early exit, runtime errors, not run).
   */
  mutants: { full: number; timeout: number; incomplete: number };
  /** Tests covering at least one mutant with a full matrix. */
  tests: number;
  /** Tests covering such a mutant that kill none of them. */
  noKills: string[];
  /** Tests whose kill set is a strict subset of another single test's; `by`: those tests, largest kill set first. */
  subsumed: { test: string; kills: number; by: string[] }[];
  /** Groups of tests with the same (non-empty) kill set. */
  duplicates: { tests: string[]; kills: number }[];
}

/**
 * A survivor ran every covering test, so its empty kill set is complete. A kill is complete
 * only when no run stopped early, and when every failure is a test (a test file that fails
 * to load cannot be split into its tests).
 */
export function hasFullMatrix(r: MatrixRow): boolean {
  if (r.status === 'Survived') return true;
  return r.status === 'Killed' && r.matrix === true && r.killedBy.every((t) => t.includes('#'));
}

export function analyzeKillMatrix(rows: readonly MatrixRow[]): KillMatrixAnalysis {
  const mutants = { full: 0, timeout: 0, incomplete: 0 };
  const covering = new Set<string>();
  /** test -> mutants it kills */
  const kills = new Map<string, Set<string>>();
  /** mutant -> tests that kill it */
  const killers = new Map<string, readonly string[]>();
  for (const r of rows) {
    if (!hasFullMatrix(r)) {
      if (r.coveredBy.length === 0 && r.killedBy.length === 0) continue;
      if (r.status === 'Timeout') mutants.timeout++;
      else if (r.status !== 'NoCoverage' && r.status !== 'Ignored' && r.status !== 'CompileError') mutants.incomplete++;
      continue;
    }
    mutants.full++;
    for (const t of r.coveredBy) covering.add(t);
    for (const t of r.killedBy) {
      covering.add(t);
      kills.set(t, (kills.get(t) ?? new Set()).add(r.key));
    }
    killers.set(r.key, r.killedBy);
  }

  const noKills = [...covering].filter((t) => !kills.has(t)).sort();
  const subsumed: KillMatrixAnalysis['subsumed'] = [];
  for (const [test, own] of kills) {
    // A test that kills all of `own` must be among the killers of each of them: start from the rarest.
    let candidates: Set<string> | undefined;
    for (const key of [...own].sort((a, b) => killers.get(a)!.length - killers.get(b)!.length)) {
      const next = new Set(killers.get(key)!.filter((t) => t !== test && (candidates === undefined || candidates.has(t))));
      candidates = next;
      if (next.size === 0) break;
    }
    // Candidates kill a superset; the same size means the same set (a duplicate, grouped below).
    const by = [...(candidates ?? [])].filter((other) => kills.get(other)!.size > own.size);
    if (by.length > 0) subsumed.push({ test, kills: own.size, by: by.sort((a, b) => kills.get(b)!.size - kills.get(a)!.size || compare(a, b)) });
  }

  // Identical kill sets: grouped by their (sorted) mutant keys.
  const bySignature = new Map<string, string[]>();
  for (const [test, own] of kills) {
    const signature = [...own].sort().join('\0');
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), test]);
  }
  const duplicates = [...bySignature.values()]
    .filter((tests) => tests.length > 1)
    .map((tests) => ({ tests: tests.sort(), kills: kills.get(tests[0]!)!.size }))
    .sort((a, b) => compare(a.tests[0]!, b.tests[0]!));

  return { mutants, tests: covering.size, noKills, subsumed: subsumed.sort((a, b) => compare(a.test, b.test)), duplicates };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
