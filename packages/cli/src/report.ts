import { relative } from 'node:path';
import { DEFAULT_THRESHOLDS, type Thresholds } from './config.ts';
import { reported, scoreLevel } from './gate.ts';
import { ACCEPTED_FILE } from './accepted.ts';
import { criticalSummary } from './critical.ts';
import { CHILD_PROCESS_WARNING, POSSIBLY_IN_CHILD_PROCESS, spawningSummary } from './child-process.ts';
import type { KillMatrixAnalysis } from './kill-matrix.ts';
import type { Report, ReportEntry } from './run.ts';

const ORDER = ['Killed', 'Timeout', 'RuntimeError', 'Survived', 'NoCoverage', 'CompileError', 'Ignored', 'Pending'] as const;

const MAX_LISTED = 20;

/**
 * Where the tests stopped short of an undetected mutant, in the order a fault must pass
 * (reach, infect, reveal); each calls for a different fix.
 */
export type Gap = 'notDetected' | 'notInfected' | 'notReached';

const GAPS: readonly { gap: Gap; heading: string; title: string }[] = [
  // Its value changes (or could not be checked) and no assertion notices: strengthen an assertion.
  { gap: 'notDetected', heading: 'not detected - tests run it, but none fails:', title: 'Mutant not detected' },
  // Reached only with inputs it does not change: add an input (a boundary value, another case).
  { gap: 'notInfected', heading: 'not infected - tests run it, but never with a value it changes:', title: 'Mutant not infected' },
  // No test runs it: add a test case.
  { gap: 'notReached', heading: 'not reached - no test runs it:', title: 'Mutant not reached' },
];

/** Why a changed test file that the runner does not collect matters. */
export function uncollectedMessage(file: string): string {
  return `${file} changed, but the test runner does not collect it: it kills nothing, so mutants only it would kill are reported as undetected (check the runner's include patterns, projects or env-based filters)`;
}

/** Why a skipped test in the change matters. */
export function skippedMessage(s: { file: string; line: number; text: string }): string {
  return `${s.file}:${s.line} skips a test in the change, so it checks nothing: ${oneLine(s.text)}`;
}

export function gapOf(e: ReportEntry): Gap | undefined {
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
      ? `mutants: ${main.length} ${report.selection === 'only' ? 'selected with --only' : 'in the diff'}${rechecked.length ? `, ${rechecked.length} rechecked` : ''} (${report.entries.length} in total; ${total})`
      : `mutants: ${report.entries.length} (${total})`,
    ORDER.filter((s) => counts.has(s))
      .map((s) => `${s} ${counts.get(s)}${s === 'Survived' && notInfected ? ` (${notInfected} not infected)` : ''}`)
      .join(' · '),
    `score${report.selection === 'only' ? ' (selected)' : report.scope === 'diff' ? ' (changed code)' : ''}: ${(report.score * 100).toFixed(1)}% [${scoreLevel(report.score, thresholds)}]${report.scope !== 'diff' && counts.get('Pending') ? ` (excluding ${counts.get('Pending')} pending)` : ''}  (${(report.durationMs / 1000).toFixed(1)}s)`,
  ];
  const notRun = [
    ...(report.notRun.sampled ? [`${report.notRun.sampled} sampled out (--mutants-per-line)`] : []),
    ...(report.notRun.budget ? [`${report.notRun.budget} over the time budget (--time-budget)`] : []),
  ];
  if (notRun.length > 0) lines.push(`not run: ${notRun.join(', ')}`);
  if (report.timeoutRetries) lines.push(`timeouts re-run with a longer budget: ${report.timeoutRetries.retried} (${report.timeoutRetries.confirmed} timed out again)`);
  for (const file of report.uncollectedTests ?? []) lines.push(`warning: ${uncollectedMessage(file)}`);
  for (const s of report.skippedTests ?? []) lines.push(`warning: ${skippedMessage(s)}`);
  const spawning = report.childProcessTests ?? [];
  if (spawning.length > 0) lines.push(`warning: ${CHILD_PROCESS_WARNING}:`, ...spawningSummary(spawning).map((line) => `  ${line}`));
  const equivalent = main.filter((e) => e.reason?.startsWith('equivalent:')).length;
  if (equivalent > 0) lines.push(`equivalent by types: ${equivalent}`);
  const accepted = main.filter((e) => e.accepted !== undefined).length;
  if (accepted > 0) lines.push(`accepted: ${accepted} undetected mutant${accepted === 1 ? '' : 's'} (${ACCEPTED_FILE})`);
  const critical = criticalSummary(report);
  if (critical) {
    const { detected, undetected, accepted } = critical;
    const run = detected.length + undetected.length;
    const score = run === 0 ? '-' : `${((detected.length / run) * 100).toFixed(1)}%`;
    lines.push(`critical regions: ${score} (${detected.length} detected, ${undetected.length} undetected, ${accepted.length} accepted)`);
  }
  // Undetected critical mutants fail the gate on their own: listed first, and only there.
  const listedCritical = new Set(critical?.undetected.map((e) => e.mutant.key));
  const rest = (entries: readonly ReportEntry[]) => entries.filter((e) => !listedCritical.has(e.mutant.key));
  const childProcess = new Set(report.childProcessMutants);
  list(lines, 'undetected in critical regions - kill or accept each:', critical?.undetected ?? [], root);
  const spawned = critical?.undetected.filter((e) => childProcess.has(e.mutant.key)).length ?? 0;
  if (spawned > 0) lines.push(`  (${spawned} ${POSSIBLY_IN_CHILD_PROCESS}: they still count, critical code must be tested in process)`);
  for (const { gap, heading } of GAPS) list(lines, heading, rest(main).filter((e) => gapOf(e) === gap && !childProcess.has(e.mutant.key)), root);
  list(lines, `${POSSIBLY_IN_CHILD_PROCESS} - no in-process test detects it:`, rest(main).filter((e) => gapOf(e) && childProcess.has(e.mutant.key)), root);
  list(lines, 'killed before, undetected now (their killing test is gone):', rest(rechecked).filter((e) => gapOf(e)), root);
  if (critical?.accepted.length) {
    lines.push('', 'accepted in critical regions:');
    for (const e of critical.accepted) lines.push(`  ${location(e, root)}  ${oneLine(e.mutant.original)} -> ${oneLine(e.mutant.replacement)}  (${e.accepted})`);
  }
  const { killed = [], stale = [] } = report.acceptance ?? {};
  const detected = new Set(killed);
  list(lines, `accepted, but detected now - remove from ${ACCEPTED_FILE}:`, report.entries.filter((e) => detected.has(e.mutant.key)), root, true);
  if (stale.length > 0) lines.push('', `accepted, but the mutant no longer exists - remove from ${ACCEPTED_FILE}:`, ...stale.map((key) => `  ${key}`));
  if (report.killMatrix) killMatrixSection(lines, report.killMatrix);
  return lines.join('\n');
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function killMatrixSection(lines: string[], k: KillMatrixAnalysis): void {
  const { full, timeout, incomplete } = k.mutants;
  const excluded = [...(timeout ? [`${timeout} timed out`] : []), ...(incomplete ? [`${incomplete} without one (not run, killed with early exit, or a test file failing to load)`] : [])];
  lines.push('', `kill matrix: ${plural(full, 'mutant')} with a full matrix, ${plural(k.tests, 'covering test')}${excluded.length ? `; excluded: ${excluded.join(', ')}` : ''}`);
  const section = (heading: string, items: readonly string[]) => {
    if (items.length === 0) return;
    lines.push('', heading, ...items.slice(0, MAX_LISTED).map((item) => `  ${item}`));
    if (items.length > MAX_LISTED) lines.push(`  … ${items.length - MAX_LISTED} more (see --reporter json or agent)`);
  };
  section('detects nothing - covers mutants, but kills none of them:', k.noKills);
  section(
    'subsumed - another test kills every mutant it kills, and more:',
    k.subsumed.map(({ test, kills, by }) => `${test}  subsumed by ${by[0]}${by.length > 1 ? ` (+${by.length - 1} more)` : ''}  (${plural(kills, 'kill')})`),
  );
  section('duplicates - the same kill set:', k.duplicates.map(({ tests, kills }) => `${tests.join(' = ')}  (${plural(kills, 'kill')})`));
}

function list(lines: string[], heading: string, entries: readonly ReportEntry[], root: string, withKey = false): void {
  if (entries.length === 0) return;
  lines.push('', heading);
  for (const e of entries.slice(0, MAX_LISTED)) {
    lines.push(`  ${location(e, root)}  ${e.status.padEnd(10)} ${oneLine(e.mutant.original)} -> ${oneLine(e.mutant.replacement)}${withKey ? `  ${e.mutant.key}` : ''}`);
  }
  if (entries.length > MAX_LISTED) lines.push(`  … ${entries.length - MAX_LISTED} more (see --reporter json or html)`);
}

/**
 * GitHub Actions workflow commands for undetected mutants, titled by gap. Unreached code is
 * annotated only with --since: over a whole project it would bury the rest.
 */
export function formatAnnotations(report: Report, root: string): string {
  const titles = new Map(GAPS.map((g) => [g.gap, g.title]));
  const childProcess = new Set(report.childProcessMutants);
  const uncollected = (report.uncollectedTests ?? []).map((file) => `::warning file=${file},title=Test file not collected::${uncollectedMessage(file)}`);
  const skipped = (report.skippedTests ?? []).map((s) => `::warning file=${s.file},line=${s.line},title=Skipped test::${skippedMessage(s)}`);
  const mutants = reported(report)
    .flatMap((e) => {
      const gap = gapOf(e);
      if (!gap || (gap === 'notReached' && report.scope !== 'diff')) return [];
      const { start, end } = e.mutant.location;
      const message = `${e.mutant.mutator}: ${oneLine(e.mutant.original)} -> ${oneLine(e.mutant.replacement)} (${childProcess.has(e.mutant.key) ? `${POSSIBLY_IN_CHILD_PROCESS}; ` : ''}if equivalent: mutator accept ${e.mutant.key} --reason ...)`;
      return [`::warning file=${relative(root, e.mutant.file)},line=${start.line},col=${start.column + 1},endLine=${end.line},endColumn=${end.column + 1},title=${titles.get(gap)}::${message}`];
    });
  return [...uncollected, ...skipped, ...mutants].join('\n');
}

function location(e: ReportEntry, root: string): string {
  return `${relative(root, e.mutant.file)}:${e.mutant.location.start.line}:${e.mutant.location.start.column + 1}`;
}

export function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
