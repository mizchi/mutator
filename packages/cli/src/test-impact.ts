// Test changes select mutation work; regressions compare verdicts only for unchanged code.
import { relative } from 'node:path';
import { type Mutant, type MutantResult, type TestInfo, testFileOf } from '@mizchi/mutator-core';
import type { ReportEntry } from './run.ts';
import { isUndetected } from './status.ts';

export interface SelectionReason {
  key: string;
  reason: 'changedTest';
  tests: string[];
}

export interface DetectionRegression {
  key: string;
  status: 'Survived' | 'NoCoverage';
  previousKillers: string[];
}

export interface TestReview {
  selection: SelectionReason[];
  tests: TestChanges;
  regressions: (DetectionRegression & { scopeHash: string })[];
}

export interface TestChanges {
  added: string[];
  changed: string[];
  removed: string[];
}

export function compareTests(before: readonly TestInfo[], after: readonly TestInfo[]): TestChanges {
  const old = new Map(before.map((t) => [t.id, t.fingerprint]));
  const current = new Map(after.map((t) => [t.id, t.fingerprint]));
  return {
    added: [...current.keys()].filter((id) => !old.has(id)).sort(),
    changed: [...current.keys()].filter((id) => old.has(id) && old.get(id) !== current.get(id)).sort(),
    removed: [...old.keys()].filter((id) => !current.has(id)).sort(),
  };
}

/** New, removed or edited tests (helper changes are part of their fingerprints). */
export function changedTestIds(before: readonly TestInfo[], after: readonly TestInfo[]): Set<string> {
  const changes = compareTests(before, after);
  return new Set([...changes.added, ...changes.changed, ...changes.removed]);
}

/** Coverage first; tests without reached mutants fall back to their observed import graph. */
export function testChangeSelection(input: {
  root: string;
  changed: ReadonlySet<string>;
  mutants: readonly Mutant[];
  coverage: ReadonlyMap<string, readonly string[]>;
  previous: readonly MutantResult[];
  deps: ReadonlyMap<string, readonly string[]>;
  prior?: readonly SelectionReason[];
}): SelectionReason[] {
  const reasons = new Map<string, Set<string>>();
  const reached = new Set<string>();
  const alive = new Set(input.mutants.map((m) => m.key));
  const add = (key: string, tests: readonly string[]) => {
    if (!alive.has(key)) return;
    for (const test of tests) if (input.changed.has(test)) {
      reasons.set(key, (reasons.get(key) ?? new Set()).add(test));
      reached.add(test);
    }
  };
  for (const [key, tests] of input.coverage) add(key, tests);
  for (const result of input.previous) add(result.key, result.coveredBy);
  for (const reason of input.prior ?? []) add(reason.key, reason.tests);
  const byFile = new Map<string, string[]>();
  for (const mutant of input.mutants) {
    const file = relative(input.root, mutant.file);
    const keys = byFile.get(file) ?? [];
    keys.push(mutant.key);
    byFile.set(file, keys);
  }
  for (const test of input.changed) {
    if (reached.has(test)) continue;
    for (const file of input.deps.get(testFileOf(test)) ?? []) {
      for (const key of byFile.get(file) ?? []) add(key, [test]);
    }
  }
  return [...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([key, tests]) => ({ key, reason: 'changedTest', tests: [...tests].sort() }));
}

/** Keep review targets while their files remain in the Git diff, including deleted tests. */
export function reviewTestChanges(before: readonly TestInfo[], after: readonly TestInfo[], changedFiles: ReadonlySet<string>, prior?: TestChanges): TestChanges {
  const changes = compareTests(before, after);
  const present = new Set(after.map((test) => test.id));
  const inDiff = (id: string) => changedFiles.has(testFileOf(id));
  const added = [...new Set([...changes.added, ...(prior?.added ?? [])])].filter((id) => inDiff(id) && present.has(id)).sort();
  const newTests = new Set(added);
  return {
    added,
    changed: [...new Set([...changes.changed, ...(prior?.changed ?? [])])].filter((id) => inDiff(id) && present.has(id) && !newTests.has(id)).sort(),
    removed: [...new Set([...changes.removed, ...(prior?.removed ?? [])])].filter((id) => inDiff(id) && !present.has(id)).sort(),
  };
}

/** A renamed or edited function is not evidence that a test became weaker. */
export function detectionRegressions(previous: readonly MutantResult[], entries: readonly ReportEntry[], history: TestReview['regressions'] = []): DetectionRegression[] {
  const before = new Map(previous.map((r) => [r.key, r]));
  const known = new Map(history.map((r) => [r.key, r]));
  return entries.flatMap((e): DetectionRegression[] => {
    const old = before.get(e.mutant.key);
    const existing = known.get(e.mutant.key);
    if (!isUndetected(e.status)) return [];
    const killers = old?.status === 'Killed' && old.scopeHash === e.mutant.scope.hash && old.file === e.mutant.file
      ? old.killedBy : existing?.scopeHash === e.mutant.scope.hash ? existing.previousKillers : undefined;
    return killers ? [{ key: e.mutant.key, status: e.status as DetectionRegression['status'], previousKillers: [...killers] }] : [];
  });
}
