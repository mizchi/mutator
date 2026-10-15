// Agent reporter: JSON on stdout for a tool or a coding agent that writes the next test.
// One record per undetected mutant, with the code around it and the kind of fix it needs.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { childProcessMessage } from './child-process.ts';
import { reported } from './gate.ts';
import { type Gap, gapOf, skippedMessage, uncollectedMessage } from './report.ts';
import type { Report } from './run.ts';

/** Scopes longer than this many lines are cut to CONTEXT lines on each side of the mutant. */
const MAX_SCOPE_LINES = 80;
const CONTEXT = 40;
/** Covering tests listed per mutant; the rest are only counted. */
const MAX_TESTS = 10;

const FIXES: Record<Gap, string> = {
  notDetected:
    'Tests run this code, but none fails when it changes: assert on the observable result that differs (return value, thrown error, state, calls). If no input can tell the two versions apart, accept the mutant instead.',
  notInfected:
    'Tests reach this code, but never with an input for which the original and the mutated expression differ: add a test input that separates them: a boundary value, or one just outside the range the condition checks.',
  notReached: 'No test executes this code: add a test case that reaches it.',
};

export interface AgentGap {
  key: string;
  gap: Gap;
  /** Outside the diff, but killed before by tests that are gone now. */
  recheck?: true;
  /** In a critical region: it fails the run until it is killed or accepted. */
  critical?: true;
  /** In a file a test's child process may load: possibly reached there, where mutants are not observed. */
  childProcess?: true;
  /** Relative to the project root; line and column are 1-based. */
  file: string;
  line: number;
  column: number;
  mutator: string;
  original: string;
  replacement: string;
  /** The enclosing function (or the lines around the mutant when it is long). */
  scope: { id: string; startLine: number; endLine: number; source: string };
  /** Up to MAX_TESTS covering tests, those whose name mentions the function first. */
  coveredBy: string[];
  coveredByCount: number;
  fix: string;
}

export interface AgentReport {
  version: 1;
  scope: Report['scope'];
  selection?: 'only';
  score: number;
  counts: Record<string, number>;
  gaps: AgentGap[];
  warnings: (
    | { kind: 'uncollectedTest'; file: string; message: string }
    | { kind: 'skippedTest'; file: string; line: number; message: string }
    | { kind: 'unknownKey'; key: string; message: string }
    | { kind: 'childProcessTest'; test: string; command: string; message: string }
  )[];
  acceptance?: { killed: string[]; stale: string[] };
}

export function formatAgentReport(report: Report, root: string): AgentReport {
  const entries = reported(report);
  const childProcess = new Set(report.childProcessMutants);
  const critical = new Set(report.criticalMutants);
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  const lines = new Map<string, string[]>();
  const linesOf = (file: string) => {
    let out = lines.get(file);
    if (!out) lines.set(file, (out = readFileSync(file, 'utf8').split('\n')));
    return out;
  };
  const gaps = entries.flatMap((e): AgentGap[] => {
    const gap = gapOf(e);
    if (!gap) return [];
    const { mutant } = e;
    const line = mutant.location.start.line;
    let startLine = mutant.scope.location.start.line;
    let endLine = mutant.scope.location.end.line;
    if (endLine - startLine > MAX_SCOPE_LINES) {
      startLine = Math.max(startLine, line - CONTEXT);
      endLine = Math.min(endLine, line + CONTEXT);
    }
    return [
      {
        key: mutant.key,
        gap,
        ...(e.focus === 'recheck' ? { recheck: true as const } : {}),
        ...(critical.has(mutant.key) ? { critical: true as const } : {}),
        ...(childProcess.has(mutant.key) ? { childProcess: true as const } : {}),
        file: relative(root, mutant.file),
        line,
        column: mutant.location.start.column + 1,
        mutator: mutant.mutator,
        original: mutant.original,
        replacement: mutant.replacement,
        scope: { id: mutant.scope.id, startLine, endLine, source: linesOf(mutant.file).slice(startLine - 1, endLine).join('\n') },
        coveredBy: rankTests(e.coveredBy, mutant.scope.id).slice(0, MAX_TESTS),
        coveredByCount: e.coveredBy.length,
        fix: FIXES[gap],
      },
    ];
  });
  return {
    version: 1,
    scope: report.scope,
    ...(report.selection ? { selection: report.selection } : {}),
    score: report.score,
    counts,
    gaps,
    warnings: [
      ...(report.uncollectedTests ?? []).map((file) => ({ kind: 'uncollectedTest' as const, file, message: uncollectedMessage(file) })),
      ...(report.skippedTests ?? []).map((s) => ({ kind: 'skippedTest' as const, file: s.file, line: s.line, message: skippedMessage(s) })),
      ...(report.unknownKeys ?? []).map((key) => ({ kind: 'unknownKey' as const, key, message: `--only: no mutant with key ${key}` })),
      ...(report.childProcessTests ?? []).map(({ test, command }) => ({ kind: 'childProcessTest' as const, test, command, message: childProcessMessage(command) })),
    ],
    ...(report.acceptance ? { acceptance: report.acceptance } : {}),
  };
}

/** Tests whose name mentions the function (the last segment of its scope id) first, otherwise in order. */
function rankTests(tests: readonly string[], scopeId: string): string[] {
  const name = scopeId.split(/[>.]/).at(-1)!.toLowerCase();
  const names = (t: string) => !name.startsWith('<') && t.slice(t.indexOf('#') + 1).toLowerCase().includes(name);
  return [...tests.filter(names), ...tests.filter((t) => !names(t))];
}
