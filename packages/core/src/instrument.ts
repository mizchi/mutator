import MagicString from 'magic-string';
import { type ParserOptions, parseSync } from 'oxc-parser';
import { type Node, isFunction, walk } from './ast.ts';
import { createAridCheck } from './arid.ts';
import { adaptMutator, createIgnoreCheck } from './plugin.ts';
import { criticalLines, disabledBy } from './disable.ts';
import { emitPlacement, headerInsertion } from './emit.ts';
import { RAW_TRANSFER, calleeName, importBindings, isReference, reexportBindings, topLevelInfo } from './facts.ts';
import { hash } from './hash.ts';
import { type Candidate, type MutatorContext, mutators } from './mutators.ts';
import { type Placement, findPlacement } from './placement.ts';
import { runtimeHeader } from './runtime.ts';
import { ScopeTracker, isTopLevelScope, normalize } from './scope.ts';
import { intersects, lineStarts, position } from './text.ts';
import type { CallSite, InstrumentOptions, InstrumentResult, Location, Mutant, MutatorName, Range, Scope } from './types.ts';

export { scanImports } from './facts.ts';

export function applyMutant(source: string, mutant: Pick<Mutant, 'range' | 'replacement'>): string {
  return source.slice(0, mutant.range.start) + mutant.replacement + source.slice(mutant.range.end);
}

export function instrument(file: string, source: string, options: InstrumentOptions = {}): InstrumentResult {
  // `experimentalRawTransfer` is accepted at runtime but missing from the published typings.
  const parsed = parseSync(file, source, { experimentalRawTransfer: RAW_TRANSFER, preserveParens: true } as ParserOptions);
  if (parsed.errors.length > 0) {
    throw new Error(`Failed to parse ${file}: ${parsed.errors.map((e) => e.message).join('; ')}`);
  }
  const program = parsed.program as unknown as Node;
  const comments: Range[] = parsed.comments.map((c) => ({ start: c.start, end: c.end }));
  const { literals, functions } = collectRanges(program);
  const lines = lineStarts(source);
  const locate = (r: Range): Location => ({ start: position(lines, r.start), end: position(lines, r.end) });
  // Nested functions are tracked as their own scopes, so they are holes in their parent's hash.
  const scopeHash = (node: Node) => hash(normalize(source, node, comments, literals, functions.filter((f) => f.start !== node.start || f.end !== node.end)));
  const excluded = new Set<string>(options.excludedMutators ?? []);
  const active = [...mutators, ...(options.mutators ?? []).map((definition) => adaptMutator(definition, file))];
  const disabled = disabledBy(parsed.comments, (offset) => position(lines, offset).line);
  // The first function or class starting on a line after `// mutator-critical`.
  const pendingCritical = criticalLines(parsed.comments, (offset) => position(lines, offset).line);
  const critical: Range[] = [];
  const ignoredBy = createIgnoreCheck(options.ignorers ?? [], file, source);
  const isArid = options.arid === false ? () => false : createAridCheck(source, options.arid ?? {});
  const ctx: MutatorContext = { source, slice: (r) => source.slice(r.start, r.end) };

  const tracker = new ScopeTracker(source, scopeHash);
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
        if (isTopLevelScope(info.id)) Object.assign(scope, topLevelInfo(info.node));
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

  // Decided on the full candidate set so that a `ranges` restriction never changes the outcome.
  const redundant = redundantCallStatements(found.map((f) => f.candidate));
  const editOf = (c: Candidate) => `${c.range.start}:${c.range.end}:${c.replacement}`;
  // On an identical edit, a low-priority mutator yields to the established one regardless of visit order.
  const primaryEdits = new Set(found.filter((f) => !LOW_PRIORITY.has(f.candidate.mutator)).map((f) => editOf(f.candidate)));

  for (const [node, names] of refs) scopes.get(node)!.refs = [...names].sort();
  const mutants: Mutant[] = [];
  const placements = new Map<Node, Placement>();
  const seenEdits = new Set<string>();
  const usedKeys = new Map<string, number>();
  for (const { candidate, scope, astPath } of found) {
    if (redundant.has(candidate)) continue;
    if (options.ranges && !options.ranges.some((r) => intersects(r, candidate.range))) continue;
    const edit = editOf(candidate);
    if (seenEdits.has(edit)) continue;
    if (LOW_PRIORITY.has(candidate.mutator) && primaryEdits.has(edit)) continue;
    seenEdits.add(edit);
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
    const reason = disabled(candidate.mutator, candidate.range.start) ?? ignoredBy(candidate.anchor) ?? (isArid(candidate.anchor) ? 'arid: logging' : undefined);
    const placement = reason ? undefined : findPlacement(candidate.anchor);
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
  }

  if (placements.size === 0) {
    const s = new MagicString(source);
    return { code: source, map: toMap(s, file), mutants, scopes: [...scopes.values()], calls, imports: importBindings(program), reexports: reexportBindings(program) };
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
  return { code, map: toMap(s, file), mutants, scopes: [...scopes.values()], calls, imports: importBindings(program), reexports: reexportBindings(program) };
}

const LOW_PRIORITY: ReadonlySet<MutatorName> = new Set(['FnValue']);

/**
 * Stryker's filter for `call();` -> `;`: only kept when no other mutant lies inside the
 * statement, since those already exercise it.
 */
function redundantCallStatements(candidates: readonly Candidate[]): Set<Candidate> {
  const out = new Set<Candidate>();
  const sorted = [...candidates].sort((a, b) => a.range.start - b.range.start);
  for (const call of candidates) {
    if (call.mutator !== 'CallExpression') continue;
    const { start, end } = call.range;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.range.start < start) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < sorted.length && sorted[i]!.range.start < end; i++) {
      const other = sorted[i]!;
      if (other !== call && other.range.end <= end) {
        out.add(call);
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

function collectRanges(program: Node): { literals: Range[]; functions: Range[] } {
  const literals: Range[] = [];
  const functions: Range[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const node = value as Node;
    if ((node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateElement' || node.type === 'JSXText') {
      literals.push({ start: node.start, end: node.end });
      return;
    }
    if (isFunction(node)) functions.push({ start: node.start, end: node.end });
    for (const k in node) {
      if (k !== 'parent') visit(node[k]);
    }
  };
  visit(program);
  const byStart = (a: Range, b: Range) => a.start - b.start;
  return { literals: literals.sort(byStart), functions: functions.sort(byStart) };
}

function toMap(s: MagicString, file: string) {
  const map = s.generateMap({ source: file, hires: true, includeContent: true });
  return { version: map.version, sources: map.sources, names: map.names, mappings: map.mappings, sourcesContent: map.sourcesContent ?? [] };
}
