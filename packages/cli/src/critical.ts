// Critical regions: code (auth, permissions, money) where every mutant must be killed or
// accepted, whatever the global thresholds say. Marked by `critical` globs in the config or
// by `// mutator-critical` on the line before a function or class (see @mizchi/mutator-core).
import { matchesGlob, relative } from 'node:path';
import { reported } from './gate.ts';
import type { Report, ReportEntry } from './run.ts';

/** Keys of the mutants in files matching `globs` (relative to the root) or marked by a comment. */
export function criticalMutants(entries: readonly ReportEntry[], root: string, globs: readonly string[]): string[] {
  const matched = new Map<string, boolean>();
  const inGlobs = (file: string) => {
    let hit = matched.get(file);
    if (hit === undefined) {
      const rel = relative(root, file).replaceAll('\\', '/');
      matched.set(file, (hit = globs.some((g) => matchesGlob(rel, g))));
    }
    return hit;
  };
  return entries.filter((e) => e.mutant.critical || (globs.length > 0 && inGlobs(e.mutant.file))).map((e) => e.mutant.key);
}

const DETECTED = new Set(['Killed', 'Timeout', 'RuntimeError']);

/** An undetected mutant: not detected, not infected or not reached (accepted ones are Ignored). */
const undetected = (e: ReportEntry) => e.status === 'Survived' || e.status === 'NoCoverage';

/**
 * The reported critical mutants, split by verdict. Mutants possibly reached in a child process
 * count as undetected: critical code should be tested in process, where mutants are observed.
 */
export function criticalSummary(report: Report): { detected: ReportEntry[]; undetected: ReportEntry[]; accepted: ReportEntry[] } | undefined {
  if (!report.criticalMutants?.length) return undefined;
  const keys = new Set(report.criticalMutants);
  const entries = reported(report).filter((e) => keys.has(e.mutant.key));
  return {
    detected: entries.filter((e) => DETECTED.has(e.status)),
    undetected: entries.filter(undetected),
    accepted: entries.filter((e) => e.accepted !== undefined),
  };
}
