// Mutant sampling and run ordering for large runs (pure functions).
import { hash } from './hash.ts';
import type { BuiltinMutatorName, Mutant } from './types.ts';

/**
 * Built-in mutators, most productive first. Google's "Practical Mutation Testing at
 * Scale" reports relational and conditional operators yielding the most useful
 * survivors; literal and structural mutators come last.
 */
export const MUTATOR_PRODUCTIVITY: readonly BuiltinMutatorName[] = [
  'EqualityOperator',
  'ConditionalExpression',
  'ArithmeticOperator',
  'LogicalOperator',
  'UnaryOperator',
  'UpdateOperator',
  'AssignmentOperator',
  'OptionalChaining',
  'MethodExpression',
  'BooleanLiteral',
  'StringLiteral',
  'ArrayDeclaration',
  'ObjectLiteral',
  'ArrowFunction',
  'CallExpression',
  'BlockStatement',
  'Regex',
  'FnValue',
];

const RANK = new Map<string, number>(MUTATOR_PRODUCTIVITY.map((name, i) => [name, i]));

/**
 * Keys of at most `n` mutants per source line (file + start line), skipping ignored
 * mutants. Within a line: built-in mutators by productivity, then custom mutators by
 * name, ties broken by a hash of the key. Deterministic: the same mutants always
 * give the same selection, so cached results stay usable across runs.
 */
export function selectPerLine(mutants: readonly Mutant[], n: number): Set<string> {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`mutants per line must be a positive integer, got ${n}`);
  const lines = new Map<string, Mutant[]>();
  for (const m of mutants) {
    if (m.ignored !== undefined) continue;
    const line = `${m.file}\0${m.location.start.line}`;
    const group = lines.get(line);
    if (group) group.push(m);
    else lines.set(line, [m]);
  }
  const keep = new Set<string>();
  for (const group of lines.values()) {
    for (const m of group.sort(byProductivity).slice(0, n)) keep.add(m.key);
  }
  return keep;
}

function byProductivity(a: Mutant, b: Mutant): number {
  const ra = RANK.get(a.mutator) ?? RANK.size;
  const rb = RANK.get(b.mutator) ?? RANK.size;
  if (ra !== rb) return ra - rb;
  if (ra === RANK.size && a.mutator !== b.mutator) return a.mutator < b.mutator ? -1 : 1;
  return compare(tieBreak(a.key), tieBreak(b.key)) || compare(a.key, b.key);
}

function tieBreak(key: string): string {
  return hash(key).padStart(11, '0');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A copy of `items`, cheapest first; equal costs ordered by key (stable across runs). */
export function orderByCost<T>(items: readonly T[], cost: (item: T) => number, key: (item: T) => string): T[] {
  return items
    .map((item) => ({ item, cost: cost(item), key: key(item) }))
    .sort((a, b) => a.cost - b.cost || compare(a.key, b.key))
    .map((e) => e.item);
}

/** Estimated run time of a mutant: the summed durations of its selected tests. */
export function estimatedCost(tests: readonly string[], durations: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const t of tests) total += durations.get(t) ?? 0;
  return total;
}
