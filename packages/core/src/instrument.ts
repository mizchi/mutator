import MagicString from 'magic-string';
import { type ParserOptions, parseSync, rawTransferSupported } from 'oxc-parser';
import { type Frame, type Node, isFunction, walk } from './ast.ts';
import { disabledBy } from './disable.ts';
import { hash } from './hash.ts';
import { type Candidate, type MutatorContext, mutators } from './mutators.ts';
import { RUNTIME_ACT, RUNTIME_COV, runtimeHeader } from './runtime.ts';
import { ScopeTracker, normalize } from './scope.ts';
import type { InstrumentOptions, InstrumentResult, Location, Mutant, Range, Scope } from './types.ts';

type PlacementKind = 'expression' | 'statement' | 'body';

interface Placement {
  frame: Frame;
  kind: PlacementKind;
  mutants: Mutant[];
}

const RAW_TRANSFER = rawTransferSupported();

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
  const literals = collectLiterals(program);
  const lines = lineStarts(source);
  const locate = (r: Range): Location => ({ start: position(lines, r.start), end: position(lines, r.end) });
  const scopeHash = (node: Node) => hash(normalize(source, node, comments, literals));
  const excluded = new Set(options.excludedMutators ?? []);
  const disabled = disabledBy(parsed.comments, (offset) => position(lines, offset).line);
  const ctx: MutatorContext = { source, slice: (r) => source.slice(r.start, r.end) };

  const tracker = new ScopeTracker(source, scopeHash);
  const path: string[] = [];
  const found: { candidate: Candidate; scope: Scope; astPath: string }[] = [];
  const scopes = new Map<Node, Scope>();

  walk(
    program,
    (frame) => {
      path.push(frame.index === undefined ? frame.key : `${frame.key}.${frame.index}`);
      if (tracker.enter(frame, path.length)) {
        const info = tracker.current!;
        scopes.set(info.node, { id: info.id, hash: tracker.hashOf(info.node), range: { start: info.node.start, end: info.node.end }, location: locate(info.node) });
      }
      const info = tracker.current;
      if (!info) return;
      for (const mutate of mutators) {
        for (const candidate of mutate(frame, ctx)) {
          if (excluded.has(candidate.mutator)) continue;
          if (options.ranges && !options.ranges.some((r) => intersects(r, candidate.range))) continue;
          found.push({ candidate, scope: scopes.get(info.node)!, astPath: path.slice(info.depth).join('/') });
        }
      }
    },
    (frame) => {
      path.pop();
      if (tracker.current?.node === frame.node) tracker.leave();
    },
  );

  const mutants: Mutant[] = [];
  const placements = new Map<Node, Placement>();
  const seenEdits = new Set<string>();
  const usedKeys = new Map<string, number>();
  for (const { candidate, scope, astPath } of found) {
    const edit = `${candidate.range.start}:${candidate.range.end}:${candidate.replacement}`;
    if (seenEdits.has(edit)) continue;
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
    };
    const reason = disabled(candidate.mutator, candidate.range.start);
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
    return { code: source, map: toMap(s, file), mutants };
  }

  const s = new MagicString(source);
  const ordered = [...placements.values()].sort((a, b) => a.frame.node.start - b.frame.node.start || b.frame.node.end - a.frame.node.end);
  for (const p of ordered) emitPlacement(s, source, p, placements);
  const { at, text } = headerInsertion(program);
  s.prependRight(at, text);
  return { code: s.toString(), map: toMap(s, file), mutants };
}

function emitPlacement(s: MagicString, source: string, { frame, kind, mutants }: Placement, placements: ReadonlyMap<Node, Placement>): void {
  const node = frame.node;
  const mutated = (m: Mutant) => source.slice(node.start, m.range.start) + m.replacement + source.slice(m.range.end, node.end);
  const act = (m: Mutant) => `${RUNTIME_ACT}(${JSON.stringify(m.key)})`;
  const cov = `${RUNTIME_COV}(${mutants.map((m) => JSON.stringify(m.key)).join(', ')})`;
  let prefix: string;
  let suffix: string;
  switch (kind) {
    case 'expression':
      prefix = `(${mutants.map((m) => `${act(m)} ? (${mutated(m)}) : `).join('')}(${cov}, (`;
      suffix = ')))';
      if (needsAsiGuard(frame, placements)) prefix = `;${prefix}`;
      break;
    case 'statement':
      prefix = `{${mutants.map((m, i) => `${i ? 'else ' : ''}if (${act(m)}) {${mutated(m)}} `).join('')}else {${cov}; `;
      suffix = '}}';
      break;
    case 'body': {
      const directives = node.body
        .filter((st: Node) => typeof st.directive === 'string')
        .map((st: Node) => source.slice(st.start, st.end))
        .join(' ');
      prefix = `{${directives}${mutants.map((m, i) => `${i ? 'else ' : ''}if (${act(m)}) ${mutated(m)} `).join('')}else {${cov}; `;
      suffix = '}}';
      break;
    }
  }
  s.appendRight(node.start, prefix);
  s.prependLeft(node.end, suffix);
}

/** An expression statement in a statement list that would now start with `(` (outermost placement only). */
function needsAsiGuard(frame: Frame, placements: ReadonlyMap<Node, Placement>): boolean {
  const start = frame.node.start;
  for (let f = frame.parent; f && f.node.start === start; f = f.parent) {
    if (placements.has(f.node)) return false;
    if (f.node.type === 'ExpressionStatement') return f.index !== undefined;
    if (f.node.type.endsWith('Statement') || f.node.type.endsWith('Declaration')) return false;
  }
  return false;
}

function headerInsertion(program: Node): { at: number; text: string } {
  const directives = (program.body as Node[]).filter((st) => typeof st.directive === 'string');
  const last = directives.at(-1);
  if (last) return { at: last.end, text: `\n${runtimeHeader}` };
  if (program.hashbang) return { at: program.hashbang.end, text: `\n${runtimeHeader}` };
  return { at: 0, text: `${runtimeHeader}\n` };
}

// ---- placement --------------------------------------------------------------

function findPlacement(anchor: Frame): { frame: Frame; kind: PlacementKind } | undefined {
  for (let f: Frame | undefined = anchor; f && f.node.type !== 'Program'; f = f.parent) {
    const kind = placementKind(f);
    if (kind) return { frame: f, kind };
  }
  return undefined;
}

const LIST_PARENTS = new Set(['Program', 'BlockStatement', 'StaticBlock', 'SwitchCase']);
const NAME_INFERRING = new Set(['VariableDeclarator', 'Property', 'PropertyDefinition', 'AssignmentExpression', 'AssignmentPattern']);
const PATTERN_PARENTS = new Set(['ArrayPattern', 'ObjectPattern', 'RestElement']);

function placementKind(frame: Frame): PlacementKind | undefined {
  const { node, parent } = frame;
  if (!parent) return undefined;
  if (node.type === 'BlockStatement') {
    if (isFunction(parent.node)) return isSuperConstructor(parent, node) ? undefined : 'body';
    if (parent.node.type === 'TryStatement' || parent.node.type === 'CatchClause') return 'body';
    return statementAllowed(frame) ? 'statement' : undefined;
  }
  if (node.type.endsWith('Statement')) {
    return statementAllowed(frame) ? 'statement' : undefined;
  }
  if (isExpression(node)) return expressionAllowed(frame) ? 'expression' : undefined;
  return undefined;
}

function statementAllowed(frame: Frame): boolean {
  const { node, parent } = frame;
  if (!parent) return false;
  if (parent.node.type === 'LabeledStatement') return false;
  if (node.type === 'ExpressionStatement') {
    if (typeof node.directive === 'string') return false;
    if (isSuperCall(node.expression)) return false;
  }
  return LIST_PARENTS.has(parent.node.type) || parent.node.type.endsWith('Statement');
}

function isExpression(node: Node): boolean {
  return (
    (node.type.endsWith('Expression') && node.type !== 'ExpressionStatement') ||
    node.type === 'Literal' ||
    node.type === 'TemplateLiteral' ||
    node.type === 'JSXElement' ||
    node.type === 'JSXFragment'
  );
}

function expressionAllowed(frame: Frame): boolean {
  const { node, key } = frame;
  const parent = frame.parent!.node;
  if (isSuperCall(node)) return false;
  switch (parent.type) {
    case 'CallExpression':
    case 'NewExpression':
      if (key === 'callee') return false;
      break;
    case 'TaggedTemplateExpression':
      return false;
    case 'UnaryExpression':
      if (parent.operator === 'delete') return false;
      break;
    case 'AssignmentExpression':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'AssignmentPattern':
      if (key === 'left') return false;
      break;
    case 'UpdateExpression':
      return false;
    case 'Property':
      if (key === 'key' && !parent.computed) return false;
      if (key === 'value' && (parent.shorthand || parent.method || parent.kind !== 'init')) return false;
      if (frame.parent!.parent?.node.type === 'ObjectPattern') return false;
      break;
    case 'MethodDefinition':
      return false;
    case 'PropertyDefinition':
    case 'AccessorProperty':
      if (key === 'key' && !parent.computed) return false;
      break;
    case 'JSXElement':
    case 'JSXFragment':
    case 'JSXAttribute':
    case 'JSXOpeningElement':
      return false;
    case 'ChainExpression':
      return false;
    case 'MemberExpression':
      if (key === 'property' && !parent.computed) return false;
      break;
  }
  if (PATTERN_PARENTS.has(parent.type)) return false;
  if (inChainSpine(frame)) return false;
  if ((node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'ClassExpression') && !node.id && NAME_INFERRING.has(parent.type)) {
    return false;
  }
  return true;
}

/** Inside `a?.b.c()` only the ChainExpression itself may be wrapped. */
function inChainSpine(frame: Frame): boolean {
  let f = frame;
  while (f.parent) {
    const p = f.parent.node;
    const spine =
      (p.type === 'MemberExpression' && f.key === 'object') ||
      (p.type === 'CallExpression' && f.key === 'callee') ||
      (p.type === 'TSNonNullExpression' && f.key === 'expression');
    if (!spine) return p.type === 'ChainExpression';
    f = f.parent;
  }
  return false;
}

function isSuperCall(node: Node): boolean {
  return node.type === 'CallExpression' && node.callee.type === 'Super';
}

function isSuperConstructor(fn: Frame, body: Node): boolean {
  return fn.parent?.node.type === 'MethodDefinition' && fn.parent.node.kind === 'constructor' && body.body.some((st: Node) => st.type === 'ExpressionStatement' && isSuperCall(st.expression));
}

// ---- helpers ----------------------------------------------------------------

function intersects(a: Range, b: Range): boolean {
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  return a.start < b.end && b.start < a.end;
}

function collectLiterals(program: Node): Range[] {
  const out: Range[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const node = value as Node;
    if ((node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateElement' || node.type === 'JSXText') {
      out.push({ start: node.start, end: node.end });
      return;
    }
    for (const k in node) {
      if (k !== 'parent') visit(node[k]);
    }
  };
  visit(program);
  return out.sort((a, b) => a.start - b.start);
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function position(starts: number[], offset: number) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! };
}

function toMap(s: MagicString, file: string) {
  const map = s.generateMap({ source: file, hires: true, includeContent: true });
  return { version: map.version, sources: map.sources, names: map.names, mappings: map.mappings, sourcesContent: map.sourcesContent ?? [] };
}
