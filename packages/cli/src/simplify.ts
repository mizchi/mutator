// Simplify reporter: code that may be unnecessary, because no test observes its removal.
// A separate view of some undetected mutants; it does not touch the score or the gate.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Mutant } from '@mizchi/mutator-core';
import { reported } from './gate.ts';
import { oneLine } from './report.ts';
import type { Report, ReportEntry } from './run.ts';

/**
 * Mutants that remove code rather than change a value:
 * - statement: `call();` -> `;` (CallExpression)
 * - block: `{ ... }` -> `{}` (BlockStatement)
 * - condition: an `if` / ternary / loop test or a part of a condition forced to `true` or
 *   `false` (ConditionalExpression), i.e. a guard or a branch removed
 * - optionalChain: `a?.b` -> `a.b`, `f?.()` -> `f()` (OptionalChaining)
 * - methodCall: `s.trim()` -> `s` (MethodExpression removals; its swaps such as
 *   `startsWith` -> `endsWith` change a value and are left out)
 * ArrowFunction (`=> undefined`), FnValue and the operator / literal mutators replace a value,
 * so a survivor there is a test gap, not code that may go.
 */
export type RemovalKind = 'statement' | 'block' | 'condition' | 'optionalChain' | 'methodCall';

export function removalKind(mutant: Pick<Mutant, 'mutator' | 'original' | 'replacement'>): RemovalKind | undefined {
  const { mutator, original, replacement } = mutant;
  switch (mutator) {
    case 'CallExpression':
      return 'statement';
    case 'BlockStatement':
      return 'block';
    case 'ConditionalExpression':
      return replacement === 'true' || replacement === 'false' ? 'condition' : undefined;
    case 'OptionalChaining':
      return 'optionalChain';
    case 'MethodExpression':
      return replacement !== '' && original.length > replacement.length && original.startsWith(replacement) ? 'methodCall' : undefined;
    default:
      return undefined;
  }
}

export interface SimplifyCandidate {
  key: string;
  kind: RemovalKind;
  /** 1-based line and column. */
  line: number;
  column: number;
  mutator: string;
  original: string;
  replacement: string;
  /** The source line, when the removed text alone says little (`?.`). */
  code?: string;
  /** Survived without a run: no covering test reaches it with a value it changes. */
  notInfected?: true;
}

export interface SimplifyGroup {
  /** Relative to the project root. */
  file: string;
  /** The enclosing function (scope id). */
  scope: string;
  startLine: number;
  endLine: number;
  candidates: SimplifyCandidate[];
}

/**
 * Covered survivors of removal mutants: every test that runs the code passes without it.
 * Accepted and equivalent mutants are `Ignored`, so they are out; so are mutants a test's
 * child process may observe (the run cannot tell).
 */
export function isSimplifyCandidate(e: ReportEntry, childProcess: ReadonlySet<string>): boolean {
  return e.status === 'Survived' && !childProcess.has(e.mutant.key) && removalKind(e.mutant) !== undefined;
}

type ReadLines = (file: string) => string[] | undefined;

const readLines: ReadLines = (file) => {
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return undefined;
  }
};

export function simplifyCandidates(report: Report, root: string, read: ReadLines = readLines): SimplifyGroup[] {
  const childProcess = new Set(report.childProcessMutants);
  const cache = new Map<string, string[] | undefined>();
  const linesOf = (file: string) => {
    if (!cache.has(file)) cache.set(file, read(file));
    return cache.get(file);
  };
  const groups = new Map<string, SimplifyGroup>();
  const entries = reported(report)
    .filter((e) => isSimplifyCandidate(e, childProcess))
    .sort((a, b) => a.mutant.file.localeCompare(b.mutant.file) || a.mutant.range.start - b.mutant.range.start || a.mutant.location.start.line - b.mutant.location.start.line);
  for (const { mutant, reason } of entries) {
    const id = `${mutant.file}\0${mutant.scope.id}`;
    let group = groups.get(id);
    if (!group) {
      const { start, end } = mutant.scope.location;
      groups.set(id, (group = { file: relative(root, mutant.file), scope: mutant.scope.id, startLine: start.line, endLine: end.line, candidates: [] }));
    }
    const kind = removalKind(mutant)!;
    const line = mutant.location.start.line;
    const code = kind === 'optionalChain' ? linesOf(mutant.file)?.[line - 1]?.trim() : undefined;
    group.candidates.push({
      key: mutant.key,
      kind,
      line,
      column: mutant.location.start.column + 1,
      mutator: mutant.mutator,
      original: mutant.original,
      replacement: mutant.replacement,
      ...(code ? { code } : {}),
      ...(reason === 'notInfected' ? { notInfected: true as const } : {}),
    });
  }
  return [...groups.values()];
}

const LABEL_WIDTH = 22;

function label(c: SimplifyCandidate): string {
  switch (c.kind) {
    case 'statement':
      return 'statement removed';
    case 'block':
      return 'block emptied';
    case 'condition':
      return `condition always ${c.replacement}`;
    case 'optionalChain':
      return c.replacement === '.' ? '?. replaced by .' : '?. removed';
    case 'methodCall':
      return 'call dropped';
  }
}

function removed(c: SimplifyCandidate): string {
  // The dropped call only: `.trim()` of `name.trim()`.
  if (c.kind === 'methodCall') return oneLine(c.original.slice(c.replacement.length).trim(), 80);
  return oneLine(c.code ?? c.original, 80);
}

export function formatSimplify(groups: readonly SimplifyGroup[]): string {
  const total = groups.reduce((n, g) => n + g.candidates.length, 0);
  if (total === 0) return 'may be unnecessary - no candidates: every removal is observed by a test, or not covered';
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const lines = [
    `may be unnecessary - no test observes the removal of this code (${plural(total, 'candidate')} in ${plural(groups.length, 'function')}):`,
    'each is also listed as a test gap in the summary; remove the code, or add a test that needs it.',
  ];
  for (const g of groups) {
    lines.push('', `${g.file}  ${g.scope} (lines ${g.startLine}-${g.endLine})`);
    const width = Math.max(...g.candidates.map((c) => `${c.line}:${c.column}`.length));
    for (const c of g.candidates) {
      const note = c.notInfected ? '  (no test reaches it with a value it changes)' : '';
      lines.push(`  ${`${c.line}:${c.column}`.padEnd(width)}  ${label(c).padEnd(LABEL_WIDTH)}  ${removed(c)}${note}`);
    }
  }
  return lines.join('\n');
}
