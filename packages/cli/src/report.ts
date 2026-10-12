import { relative } from 'node:path';
import { DEFAULT_THRESHOLDS, type Thresholds } from './config.ts';
import { reported, scoreLevel } from './gate.ts';
import type { Report, ReportEntry } from './run.ts';

const ORDER = ['Killed', 'Timeout', 'RuntimeError', 'Survived', 'NoCoverage', 'CompileError', 'Ignored', 'Pending'] as const;

const MAX_LISTED = 20;

/**
 * Where the tests stopped short of an undetected mutant, in the order a fault must pass
 * (reach, infect, reveal); each calls for a different fix.
 */
type Gap = 'notDetected' | 'notInfected' | 'notReached';

const GAPS: readonly { gap: Gap; heading: string; title: string }[] = [
  // Its value changes (or could not be checked) and no assertion notices: strengthen an assertion.
  { gap: 'notDetected', heading: 'not detected - tests run it, but none fails:', title: 'Mutant not detected' },
  // Reached only with inputs it does not change: add an input (a boundary value, another case).
  { gap: 'notInfected', heading: 'not infected - tests run it, but never with a value it changes:', title: 'Mutant not infected' },
  // No test runs it: add a test case.
  { gap: 'notReached', heading: 'not reached - no test runs it:', title: 'Mutant not reached' },
];

function gapOf(e: ReportEntry): Gap | undefined {
  if (e.status === 'NoCoverage') return 'notReached';
  if (e.status === 'Survived') return e.reason === 'notInfected' ? 'notInfected' : 'notDetected';
  return undefined;
}

export function formatSummary(report: Report, root: string, thresholds: Thresholds = DEFAULT_THRESHOLDS): string {
  const diff = report.scope === 'diff';
  const main = diff ? report.entries.filter((e) => e.focus === 'diff') : report.entries;
  const rechecked = report.entries.filter((e) => e.focus === 'recheck');
  const counts = new Map<string, number>();
  for (const e of main) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  const notInfected = main.filter((e) => gapOf(e) === 'notInfected').length;
  const reused = report.entries.filter((e) => e.source === 'reuse').length;
  const total = `executed ${report.executed}, reused ${reused}`;
  const lines = [
    diff
      ? `mutants: ${main.length} in the diff${rechecked.length ? `, ${rechecked.length} rechecked` : ''} (${report.entries.length} in total; ${total})`
      : `mutants: ${report.entries.length} (${total})`,
    ORDER.filter((s) => counts.has(s))
      .map((s) => `${s} ${counts.get(s)}${s === 'Survived' && notInfected ? ` (${notInfected} not infected)` : ''}`)
      .join(' · '),
    `score${report.scope === 'diff' ? ' (changed code)' : ''}: ${(report.score * 100).toFixed(1)}% [${scoreLevel(report.score, thresholds)}]${report.scope !== 'diff' && counts.get('Pending') ? ` (excluding ${counts.get('Pending')} pending)` : ''}  (${(report.durationMs / 1000).toFixed(1)}s)`,
  ];
  const notRun = [
    ...(report.notRun.sampled ? [`${report.notRun.sampled} sampled out (--mutants-per-line)`] : []),
    ...(report.notRun.budget ? [`${report.notRun.budget} over the time budget (--time-budget)`] : []),
  ];
  if (notRun.length > 0) lines.push(`not run: ${notRun.join(', ')}`);
  for (const { gap, heading } of GAPS) list(lines, heading, main.filter((e) => gapOf(e) === gap), root);
  list(lines, 'killed before, undetected now (their killing test is gone):', rechecked.filter((e) => gapOf(e)), root);
  return lines.join('\n');
}

function list(lines: string[], heading: string, entries: readonly ReportEntry[], root: string): void {
  if (entries.length === 0) return;
  lines.push('', heading);
  for (const e of entries.slice(0, MAX_LISTED)) lines.push(`  ${location(e, root)}  ${e.status.padEnd(10)} ${oneLine(e.mutant.original)} -> ${oneLine(e.mutant.replacement)}`);
  if (entries.length > MAX_LISTED) lines.push(`  … ${entries.length - MAX_LISTED} more (see --reporter json or html)`);
}

/**
 * GitHub Actions workflow commands for undetected mutants, titled by gap. Unreached code is
 * annotated only with --since: over a whole project it would bury the rest.
 */
export function formatAnnotations(report: Report, root: string): string {
  const titles = new Map(GAPS.map((g) => [g.gap, g.title]));
  return reported(report)
    .flatMap((e) => {
      const gap = gapOf(e);
      if (!gap || (gap === 'notReached' && report.scope !== 'diff')) return [];
      const { start, end } = e.mutant.location;
      const message = `${e.mutant.mutator}: ${oneLine(e.mutant.original)} -> ${oneLine(e.mutant.replacement)}`;
      return [`::warning file=${relative(root, e.mutant.file)},line=${start.line},col=${start.column + 1},endLine=${end.line},endColumn=${end.column + 1},title=${titles.get(gap)}::${message}`];
    })
    .join('\n');
}

function location(e: ReportEntry, root: string): string {
  return `${relative(root, e.mutant.file)}:${e.mutant.location.start.line}:${e.mutant.location.start.column + 1}`;
}

export function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
