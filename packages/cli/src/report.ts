import { relative } from 'node:path';
import { DEFAULT_THRESHOLDS, type Thresholds } from './config.ts';
import { reported, scoreLevel } from './gate.ts';
import type { Report, ReportEntry } from './run.ts';

const ORDER = ['Killed', 'Timeout', 'RuntimeError', 'Survived', 'NoCoverage', 'CompileError', 'Ignored', 'Pending'] as const;

const MAX_LISTED = 20;

export function formatSummary(report: Report, root: string, thresholds: Thresholds = DEFAULT_THRESHOLDS): string {
  const diff = report.scope === 'diff';
  const main = diff ? report.entries.filter((e) => e.focus === 'diff') : report.entries;
  const rechecked = report.entries.filter((e) => e.focus === 'recheck');
  const counts = new Map<string, number>();
  for (const e of main) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  const reused = report.entries.filter((e) => e.source === 'reuse').length;
  const total = `executed ${report.executed}, reused ${reused}`;
  const lines = [
    diff
      ? `mutants: ${main.length} in the diff${rechecked.length ? `, ${rechecked.length} rechecked` : ''} (${report.entries.length} in total; ${total})`
      : `mutants: ${report.entries.length} (${total})`,
    ORDER.filter((s) => counts.has(s))
      .map((s) => `${s} ${counts.get(s)}`)
      .join(' · '),
    `score${report.scope === 'diff' ? ' (changed code)' : ''}: ${(report.score * 100).toFixed(1)}% [${scoreLevel(report.score, thresholds)}]${report.scope !== 'diff' && counts.get('Pending') ? ` (excluding ${counts.get('Pending')} pending)` : ''}  (${(report.durationMs / 1000).toFixed(1)}s)`,
  ];
  const notRun = [
    ...(report.notRun.sampled ? [`${report.notRun.sampled} sampled out (--mutants-per-line)`] : []),
    ...(report.notRun.budget ? [`${report.notRun.budget} over the time budget (--time-budget)`] : []),
  ];
  if (notRun.length > 0) lines.push(`not run: ${notRun.join(', ')}`);
  list(lines, 'undetected:', main, root);
  list(lines, 'killed before, undetected now (their killing test is gone):', rechecked, root);
  return lines.join('\n');
}

function list(lines: string[], title: string, entries: readonly ReportEntry[], root: string): void {
  // Survivors first (tests ran and missed them), then mutants no test reaches.
  const undetected = [...entries.filter((e) => e.status === 'Survived'), ...entries.filter((e) => e.status === 'NoCoverage')];
  if (undetected.length === 0) return;
  lines.push('', title);
  for (const e of undetected.slice(0, MAX_LISTED)) lines.push(`  ${location(e, root)}  ${e.status.padEnd(10)} ${oneLine(e.mutant.original)} -> ${oneLine(e.mutant.replacement)}`);
  if (undetected.length > MAX_LISTED) lines.push(`  … ${undetected.length - MAX_LISTED} more undetected (see --reporter json or html)`);
}

/** GitHub Actions workflow commands for undetected mutants. */
export function formatAnnotations(report: Report, root: string): string {
  return reported(report)
    .filter((e) => e.status === 'Survived')
    .map((e) => {
      const { start, end } = e.mutant.location;
      const message = `${e.mutant.mutator}: ${oneLine(e.mutant.original)} -> ${oneLine(e.mutant.replacement)}`;
      return `::warning file=${relative(root, e.mutant.file)},line=${start.line},col=${start.column + 1},endLine=${end.line},endColumn=${end.column + 1},title=Survived mutant::${message}`;
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
