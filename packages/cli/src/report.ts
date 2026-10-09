import { relative } from 'node:path';
import { DEFAULT_THRESHOLDS, type Thresholds } from './config.ts';
import { scoreLevel } from './gate.ts';
import type { Report, ReportEntry } from './run.ts';

const ORDER = ['Killed', 'Timeout', 'RuntimeError', 'Survived', 'NoCoverage', 'Ignored', 'Pending'] as const;

export function formatSummary(report: Report, root: string, thresholds: Thresholds = DEFAULT_THRESHOLDS): string {
  const counts = new Map<string, number>();
  for (const e of report.entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  const reused = report.entries.filter((e) => e.source === 'reuse').length;
  const lines = [
    `mutants: ${report.entries.length} (executed ${report.executed}, reused ${reused})`,
    ORDER.filter((s) => counts.has(s))
      .map((s) => `${s} ${counts.get(s)}`)
      .join(' · '),
    `score: ${(report.score * 100).toFixed(1)}% [${scoreLevel(report.score, thresholds)}]${counts.get('Pending') ? ` (excluding ${counts.get('Pending')} pending)` : ''}  (${(report.durationMs / 1000).toFixed(1)}s)`,
  ];
  const survivors = report.entries.filter((e) => e.status === 'Survived' || e.status === 'NoCoverage');
  if (survivors.length > 0) {
    lines.push('', 'undetected:');
    for (const e of survivors) lines.push(`  ${location(e, root)}  ${e.status.padEnd(10)} ${oneLine(e.mutant.original)} -> ${oneLine(e.mutant.replacement)}`);
  }
  return lines.join('\n');
}

/** GitHub Actions workflow commands for undetected mutants. */
export function formatAnnotations(report: Report, root: string): string {
  return report.entries
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
