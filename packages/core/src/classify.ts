// The verdict of a mutant run, from what the runner reported: each adapter normalises its
// runner's report into a RunReport, so every runner decides Killed / Timeout / ... the same way.
import type { MutantRunResult } from './runner.ts';
import { HIT_LIMIT_MESSAGE } from './runtime.ts';

/** A mutant run as the runner reported it. */
export interface RunReport {
  /** Tests that ran (a test may appear more than once, e.g. per retry). */
  tests: readonly { id: string; failed: boolean; messages: readonly string[] }[];
  /** Errors of a test file outside its tests (it failed to load); `file` is relative to the root. */
  fileErrors: readonly { file: string; message: string }[];
  /** Errors outside any test file (a global setup, an unhandled rejection, a broken config). */
  runErrors: readonly string[];
  /** Ids of the tests the run was for: only their failures count. */
  selected: ReadonlySet<string>;
}

export function classifyRun(report: RunReport): Omit<MutantRunResult, 'durationMs'> {
  const failed = report.tests.filter((t) => t.failed && report.selected.has(t.id));
  const tests = [...new Set(failed.map((t) => t.id))];
  const files = [...new Set(report.fileErrors.map((e) => e.file))];
  if (tests.length === 0 && files.length === 0) return { status: report.runErrors.length > 0 ? 'RuntimeError' : 'Survived', killedBy: [] };
  // The hit limit guards against endless loops: a run stopped only by it (in tests, or while
  // loading a test file) is a timeout. Errors outside test files do not decide it.
  const hitLimit = (messages: readonly string[]) => messages.length > 0 && messages.every((m) => m.includes(HIT_LIMIT_MESSAGE));
  if (failed.every((t) => hitLimit(t.messages)) && report.fileErrors.every((e) => hitLimit([e.message]))) {
    return { status: 'Timeout', timeoutCause: 'hitLimit', killedBy: [] };
  }
  // Test files that broke with no test failing: the mutant broke the run, not a test.
  if (tests.length === 0) return { status: 'RuntimeError', killedBy: files };
  return { status: 'Killed', killedBy: [...tests, ...files] };
}
