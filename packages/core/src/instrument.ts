import MagicString from 'magic-string';
import { parseSync } from 'oxc-parser';
import { parseSource } from './parse.ts';
import { type Node, isFunction, walk } from './ast.ts';
import { createAridCheck } from './arid.ts';
import { adaptMutator, createIgnoreCheck } from './plugin.ts';
import { criticalLines, disabledBy } from './disable.ts';
import { emitPlacement, headerInsertion, startsWithSourceParenRegex } from './emit.ts';
import { calleeName, importBindings, isReference, moduleLoads, reexportBindings, topLevelInfo } from './facts.ts';
import { hash } from './hash.ts';
import { type Candidate, type MutatorContext, OPT_IN_MUTATORS, mutators } from './mutators.ts';
import { type Placement, findPlacement } from './placement.ts';
import { runtimeHeader } from './runtime.ts';
import { createScopeTracker, isTopLevelScope } from '@mizchi/test-impact/source';
import { intersects, lineStarts, position } from './text.ts';
import type { CallSite, InstrumentOptions, InstrumentResult, Location, Mutant, MutatorName, Range, Scope, SkipCategory, SkippedCandidate } from './types.ts';

export { scanImports } from './facts.ts';

export function applyMutant(source: string, mutant: Pick<Mutant, 'range' | 'replacement'>): string {
  return source.slice(0, mutant.range.start) + mutant.replacement + source.slice(mutant.range.end);
}

export function instrument(file: string, source: string, options: InstrumentOptions = {}): InstrumentResult {
  const parsed = parseSource(file, source, { preserveParens: true });
  if (parsed.errors.length > 0) {
    throw new Error(`Failed to parse ${file}: ${parsed.errors.map((e) => e.message).join('; ')}`);
  }
  const program = parsed.program as unknown as Node;
  const lines = lineStarts(source);
  const locate = (r: Range): Location => ({ start: position(lines, r.start), end: position(lines, r.end) });
  const enabled = new Set<string>(options.enabledMutators ?? []);
  const excluded = new Set<string>([...(options.excludedMutators ?? []), ...[...OPT_IN_MUTATORS].filter((m) => !enabled.has(m))]);
  const active = [...mutators, ...(options.mutators ?? []).map((definition) => adaptMutator(definition, file))];
  const disabled = disabledBy(parsed.comments, (offset) => position(lines, offset).line);
  // The first function or class starting on a line after `// mutator-critical`.
  const pendingCritical = criticalLines(parsed.comments, (offset) => position(lines, offset).line);
  const critical: Range[] = [];
  const ignoredBy = createIgnoreCheck(options.ignorers ?? [], file, source);
  const isArid = options.arid === false ? () => false : createAridCheck(source, options.arid ?? {});
  const ctx: MutatorContext = { source, slice: (r) => source.slice(r.start, r.end), ...(options.minimalRelational ? { minimalRelational: true } : {}) };

  const tracker = createScopeTracker(source, program, parsed.comments);
  const path: string[] = [];
  const found: { candidate: Candidate; scope: Scope; astPath: string }[] = [];
  const calls: CallSite[] = [];
  const refs = new Map<Node, Set<string>>();
  const scopes = new Map<Node, Scope>();

  walk(
    program,
    (frame) => {
      path.push(frame.index === undefined ? frame.key : `${frame.key}.${frame.index}`);
      const { node } = frame;
      if (pendingCritical.size > 0 && (isFunction(node) || node.type === 'ClassDeclaration' || node.type === 'ClassExpression')) {
        const line = position(lines, node.start).line;
        if (pendingCritical.delete(line)) critical.push({ start: node.start, end: node.end });
      }
      if (tracker.enter(frame, path.length)) {
        const info = tracker.current!;
        const scope: Scope = { id: info.id, hash: tracker.hashOf(info.node), range: { start: info.node.start, end: info.node.end }, location: locate(info.node) };
        if (isTopLevelScope(info.id)) {
          Object.assign(scope, topLevelInfo(info.node));
          // Two registrations can have the same scope hash and different inline callbacks.
          if (info.node.declaration?.type !== 'FunctionDeclaration') {
            scope.initializationHash = tracker.hashOf(info.node, true);
          }
        }
        scopes.set(info.node, scope);
        refs.set(info.node, new Set());
      }
      const info = tracker.current;
      if (!info) return;
      if (isReference(frame)) refs.get(info.node)!.add(frame.node.name);
      if (frame.node.type === 'CallExpression' || frame.node.type === 'NewExpression') {
        const callee = calleeName(frame.node.callee);
        if (callee) calls.push({ scope: info.id, callee });
      }
      for (const mutate of active) {
        for (const candidate of mutate(frame, ctx)) {
          if (excluded.has(candidate.mutator)) continue;
          found.push({ candidate, scope: scopes.get(info.node)!, astPath: path.slice(info.depth).join('/') });
        }
      }
    },
    (frame) => {
      path.pop();
      if (tracker.current?.node === frame.node) tracker.leave();
    },
  );

  const editOf = (c: Candidate) => `${c.range.start}:${c.range.end}:${c.replacement}`;
  // On an identical edit, a low-priority mutator yields to the established one regardless of visit order.
  const primaryEdit = new Map<string, Candidate>();
  for (const { candidate } of found) {
    if (!LOW_PRIORITY.has(candidate.mutator) && !primaryEdit.has(editOf(candidate))) primaryEdit.set(editOf(candidate), candidate);
  }
  const inRange = (c: Candidate) => !options.ranges || options.ranges.some((r) => intersects(r, c.range));
  const reasonOf = (c: Candidate) => disabled(c.mutator, c.range.start) ?? ignoredBy(c.anchor) ?? (isArid(c.anchor) ? 'arid: logging' : undefined);
  const placementOf = (c: Candidate): Omit<Placement, 'mutants'> | undefined => {
    const p = findPlacement(c.anchor);
    return p && !(p.kind === 'expression' && startsWithSourceParenRegex(source, p.frame.node, c)) ? p : undefined;
  };

  // Duplicates first: the first candidate (or the primary one) of an edit stands for the others.
  const sameEdit = new Map<Candidate, Candidate>();
  const firstOfEdit = new Map<string, Candidate>();
  for (const { candidate } of found) {
    const edit = editOf(candidate);
    const primary = LOW_PRIORITY.has(candidate.mutator) ? primaryEdit.get(edit) : undefined;
    const first = primary ?? firstOfEdit.get(edit);
    if (first) sameEdit.set(candidate, first);
    else firstOfEdit.set(edit, candidate);
  }
  // Decided on the full candidate set so that a `ranges` restriction never changes the outcome.
  // An ignored inner mutant still justifies the skip: ignoring code must not add mutants to it.
  const redundant = subsumedByInner(found.map((f) => f.candidate), options.subsumeCoarse ? COARSE : CALL_ONLY);

  for (const [node, names] of refs) scopes.get(node)!.refs = [...names].sort();
  const mutants: Mutant[] = [];
  const pending: { skip: SkippedCandidate; by?: Candidate }[] = [];
  const mutantOf = new Map<Candidate, Mutant>();
  const placements = new Map<Node, Placement>();
  const usedKeys = new Map<string, number>();
  for (const { candidate, scope, astPath } of found) {
    if (!inRange(candidate)) continue;
    const skippedAs = (rule: string, category: SkipCategory, by: Candidate, heuristic = false) =>
      pending.push({
        skip: { file, mutator: candidate.mutator, range: candidate.range, location: locate(candidate.range), original: ctx.slice(candidate.range), replacement: candidate.replacement, rule, category, ...(heuristic ? { heuristic: true as const } : {}) },
        by,
      });
    if (candidate.skip) {
      const { rule, category, heuristic } = candidate.skip;
      pending.push({
        skip: { file, mutator: candidate.mutator, range: candidate.range, location: locate(candidate.range), original: ctx.slice(candidate.range), replacement: candidate.replacement, rule, category, ...(heuristic ? { heuristic } : {}) },
      });
      continue;
    }
    const first = sameEdit.get(candidate);
    if (first) {
      skippedAs('same-edit', 'duplicate', first);
      continue;
    }
    const justifier = redundant.get(candidate);
    if (justifier) {
      skippedAs(candidate.mutator === 'CallExpression' ? 'redundant-call' : 'solitary', 'subsumed', sameEdit.get(justifier) ?? justifier, true);
      continue;
    }
    let key = hash(`${options.identity ?? file}\0${scope.id}\0${astPath}\0${candidate.mutator}\0${candidate.replacement}`);
    const dup = (usedKeys.get(key) ?? 0) + 1;
    usedKeys.set(key, dup);
    if (dup > 1) key = `${key}-${dup}`;
    const mutant: Mutant = {
      key,
      file,
      mutator: candidate.mutator,
      range: candidate.range,
      location: locate(candidate.range),
      original: ctx.slice(candidate.range),
      replacement: candidate.replacement,
      scope,
      ...(critical.some((r) => r.start <= candidate.range.start && candidate.range.end <= r.end) ? { critical: true as const } : {}),
    };
    const reason = reasonOf(candidate);
    const placement = reason ? undefined : placementOf(candidate);
    if (reason) {
      mutant.ignored = reason;
    } else if (!placement) {
      mutant.ignored = 'unplaceable';
    } else {
      const entry = placements.get(placement.frame.node) ?? { ...placement, mutants: [] };
      entry.mutants.push(mutant);
      placements.set(placement.frame.node, entry);
    }
    mutants.push(mutant);
    mutantOf.set(candidate, mutant);
  }
  const skipped = pending.map(({ skip, by }) => {
    const key = by && mutantOf.get(by)?.key;
    return key ? { ...skip, by: key } : skip;
  });

  const modules = { imports: importBindings(program), reexports: reexportBindings(program), loads: moduleLoads(program) };
  if (placements.size === 0) {
    const s = new MagicString(source);
    return { code: source, map: toMap(s, file), mutants, skipped, scopes: [...scopes.values()], calls, ...modules };
  }

  const s = new MagicString(source);
  const ordered = [...placements.values()].sort((a, b) => a.frame.node.start - b.frame.node.start || b.frame.node.end - a.frame.node.end);
  const placedKeys = ordered.flatMap((p) => p.mutants.map((m) => m.key));
  const indexOf = new Map(placedKeys.map((key, i) => [key, i]));
  for (const p of ordered) emitPlacement(s, source, p, placements, indexOf, options.weak !== false);
  const { at, text } = headerInsertion(program, runtimeHeader(placedKeys));
  s.prependRight(at, text);
  const code = s.toString();
  if (options.mutators?.length) assertCustomMutantsParse(file, source, code, mutants, new Set(options.mutators.map((m) => m.name)));
  return { code, map: toMap(s, file), mutants, skipped, scopes: [...scopes.values()], calls, ...modules };
}

const LOW_PRIORITY: ReadonlySet<MutatorName> = new Set(['FnValue']);

/** Always: Stryker's filter for `call();` -> `;`. */
const CALL_ONLY: ReadonlySet<MutatorName> = new Set(['CallExpression']);
/** With `subsumeCoarse`: every mutator that removes or empties a region holding other code. */
const COARSE: ReadonlySet<MutatorName> = new Set(['CallExpression', 'BlockStatement', 'ArrayDeclaration', 'ObjectLiteral', 'ArrowFunction', 'FnValue']);

/**
 * A coarse candidate (`call();` -> `;`, `{ ... }` -> `{}`, ...) is dropped when another candidate
 * lies strictly inside its range, since a test that kills that one exercises the coarse change's
 * code too. Maps each dropped candidate to that inner candidate. Heuristic: a test can kill the
 * inner change and still miss the removal (e.g. `{ return "."; }` -> `{}` when callers coerce).
 */
function subsumedByInner(candidates: readonly Candidate[], coarse: ReadonlySet<MutatorName>): Map<Candidate, Candidate> {
  const out = new Map<Candidate, Candidate>();
  const sorted = [...candidates].sort((a, b) => a.range.start - b.range.start);
  for (const outer of candidates) {
    if (!coarse.has(outer.mutator)) continue;
    const { start, end } = outer.range;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.range.start < start) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < sorted.length && sorted[i]!.range.start < end; i++) {
      const other = sorted[i]!;
      // The same range is a sibling edit, not a finer one (except for a call statement, as before).
      const sameRange = other.range.start === start && other.range.end === end;
      if (other !== outer && other.range.end <= end && (!sameRange || outer.mutator === 'CallExpression')) {
        out.set(outer, other);
        break;
      }
    }
  }
  return out;
}

/** Custom mutators are untrusted: make sure the instrumented output still parses. */
function assertCustomMutantsParse(file: string, source: string, code: string, mutants: readonly Mutant[], custom: ReadonlySet<string>): void {
  if (parseSync(file, code).errors.length === 0) return;
  for (const m of mutants) {
    if (!custom.has(m.mutator) || m.ignored) continue;
    if (parseSync(file, applyMutant(source, m)).errors.length > 0) {
      throw new Error(`mutator ${m.mutator} produced invalid code in ${file}:${m.location.start.line}: ${JSON.stringify(m.original)} -> ${JSON.stringify(m.replacement)}`);
    }
  }
  throw new Error(`instrumenting ${file} with custom mutators produced invalid code`);
}

// ---- helpers ----------------------------------------------------------------


function toMap(s: MagicString, file: string) {
  const map = s.generateMap({ source: file, hires: true, includeContent: true });
  return { version: map.version, sources: map.sources, names: map.names, mappings: map.mappings, sourcesContent: map.sourcesContent ?? [] };
}
