import MagicString from 'magic-string';
import { type ParserOptions, parseSync, rawTransferSupported } from 'oxc-parser';
import { type Frame, type Node, isFunction, unwrap, walk } from './ast.ts';
import { createAridCheck } from './arid.ts';
import { adaptMutator, createIgnoreCheck } from './plugin.ts';
import { disabledBy } from './disable.ts';
import { hash } from './hash.ts';
import { type Candidate, type MutatorContext, mutators } from './mutators.ts';
import { RUNTIME_ACTIVE, RUNTIME_COLLECT, RUNTIME_COV, RUNTIME_HIT, RUNTIME_WEAK, runtimeHeader } from './runtime.ts';
import { ScopeTracker, normalize } from './scope.ts';
import type { CallSite, ImportBinding, InstrumentOptions, InstrumentResult, Location, Mutant, MutatorName, Range, Scope } from './types.ts';

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
  const { literals, functions } = collectRanges(program);
  const lines = lineStarts(source);
  const locate = (r: Range): Location => ({ start: position(lines, r.start), end: position(lines, r.end) });
  // Nested functions are tracked as their own scopes, so they are holes in their parent's hash.
  const scopeHash = (node: Node) => hash(normalize(source, node, comments, literals, functions.filter((f) => f.start !== node.start || f.end !== node.end)));
  const excluded = new Set<string>(options.excludedMutators ?? []);
  const active = [...mutators, ...(options.mutators ?? []).map((definition) => adaptMutator(definition, file))];
  const disabled = disabledBy(parsed.comments, (offset) => position(lines, offset).line);
  const ignoredBy = createIgnoreCheck(options.ignorers ?? [], file, source);
  const isArid = options.arid === false ? () => false : createAridCheck(source, options.arid ?? {});
  const ctx: MutatorContext = { source, slice: (r) => source.slice(r.start, r.end) };

  const tracker = new ScopeTracker(source, scopeHash);
  const path: string[] = [];
  const found: { candidate: Candidate; scope: Scope; astPath: string }[] = [];
  const calls: CallSite[] = [];
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
    return { code: source, map: toMap(s, file), mutants, scopes: [...scopes.values()], calls, imports: importBindings(program) };
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
  return { code, map: toMap(s, file), mutants, scopes: [...scopes.values()], calls, imports: importBindings(program) };
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

function emitPlacement(s: MagicString, source: string, { frame, kind, mutants }: Placement, placements: ReadonlyMap<Node, Placement>, indexOf: ReadonlyMap<string, number>, weakProbes: boolean): void {
  const node = frame.node;
  const mutated = (m: Mutant) => source.slice(node.start, m.range.start) + m.replacement + source.slice(m.range.end, node.end);
  const act = (m: Mutant) => `${RUNTIME_ACTIVE} === ${JSON.stringify(m.key)} && ${RUNTIME_HIT}()`;
  const weak = weakProbes && kind === 'expression' ? weakChecks(frame, source, mutants, mutated, indexOf) : [];
  const cov = `${RUNTIME_COLLECT} && (${[`${RUNTIME_COV}(${mutants.map((m) => indexOf.get(m.key)).join(', ')})`, ...weak].join(', ')})`;
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

const WEAK_MUTATORS = new Set(['EqualityOperator', 'ArithmeticOperator', 'ConditionalExpression']);
const WEAK_OPERATORS = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!==', '+', '-', '*', '/', '%']);

/** Expressions that can be evaluated again without any observable effect. */
function isPure(node: Node): boolean {
  switch (node.type) {
    case 'Identifier':
    case 'ThisExpression':
      return true;
    case 'Literal':
      return !node.regex; // a regex literal is a new object on every evaluation
    case 'ParenthesizedExpression':
      return isPure(node.expression);
    case 'UnaryExpression':
      return ['-', '+', '!', '~', 'typeof'].includes(node.operator) && isPure(node.argument);
    case 'TemplateLiteral':
      return node.expressions.length === 0;
    case 'MemberExpression':
      // `.length` of a binding: strings and arrays, no getters in practice.
      return !node.computed && node.property.name === 'length' && node.object.type === 'Identifier';
    default:
      return false;
  }
}

/**
 * Weak-mutation probes for mutants that replace the whole placed expression and
 * whose original and mutated forms can both be re-evaluated without side effects.
 * Only runs in dry runs (behind the collect flag). Both forms are evaluated in
 * place: being side-effect free, the only possible exception (TDZ, `.length` of
 * null) is the one the original expression throws right after anyway.
 */
function weakChecks(frame: Frame, source: string, mutants: readonly Mutant[], mutated: (m: Mutant) => string, indexOf: ReadonlyMap<string, number>): string[] {
  const node = frame.node;
  const inner = unwrapParens(node);
  const pure = (inner.type === 'BinaryExpression' && WEAK_OPERATORS.has(inner.operator) && isPure(inner.left) && isPure(inner.right)) || isPure(inner);
  if (!pure) return [];
  const testPosition = isTestPosition(frame);
  const wrap = (code: string) => (testPosition ? `!!(${code})` : `(${code})`);
  const original = source.slice(node.start, node.end);
  const args: string[] = [];
  for (const m of mutants) {
    if (!WEAK_MUTATORS.has(m.mutator) || m.range.start !== node.start || m.range.end !== node.end) continue;
    // `a * b` -> `a / b` can throw where the original does not (BigInt division by zero);
    // every other swap keeps the operand types, so it throws only when the original does.
    if (m.mutator === 'ArithmeticOperator' && inner.type === 'BinaryExpression' && inner.operator === '*') continue;
    m.weak = true;
    args.push(`${indexOf.get(m.key)}, ${wrap(mutated(m))}`);
  }
  // One call per evaluation: the original value, then (mutant index, mutated value) pairs.
  return args.length ? [`${RUNTIME_WEAK}(${wrap(original)}, ${args.join(', ')})`] : [];
}

function unwrapParens(node: Node): Node {
  return node.type === 'ParenthesizedExpression' ? unwrapParens(node.expression) : node;
}

/** The value is only used for its truthiness (if / loop / ternary test). */
function isTestPosition(frame: Frame): boolean {
  let f = frame;
  while (f.parent && f.parent.node.type === 'ParenthesizedExpression') f = f.parent;
  const parent = f.parent?.node;
  return f.key === 'test' && parent !== undefined && ['IfStatement', 'WhileStatement', 'DoWhileStatement', 'ForStatement', 'ConditionalExpression'].includes(parent.type);
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

function headerInsertion(program: Node, runtimeHeader: string): { at: number; text: string } {
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
    node.type === 'Identifier' ||
    node.type === 'TemplateLiteral' ||
    node.type === 'JSXElement' ||
    node.type === 'JSXFragment'
  );
}

const TRANSPARENT = new Set(['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);

/** The position a node really occupies: `(o?.m)()` puts `o?.m` in callee position. */
function effectivePosition(frame: Frame): { parent: Node; key: string } {
  let f = frame;
  while (f.parent && TRANSPARENT.has(f.parent.node.type) && f.parent.parent) f = f.parent;
  return { parent: f.parent!.node, key: f.key };
}

function expressionAllowed(frame: Frame): boolean {
  const { node } = frame;
  if (isSuperCall(node)) return false;
  // Wrapping a callee, tag, delete operand or assignment target changes its meaning,
  // even when it is parenthesized.
  const position = effectivePosition(frame);
  switch (position.parent.type) {
    case 'CallExpression':
    case 'NewExpression':
      if (position.key === 'callee') return false;
      break;
    case 'TaggedTemplateExpression':
      if (position.key === 'tag') return false;
      break;
    case 'UnaryExpression':
      if (position.parent.operator === 'delete') return false;
      break;
    case 'AssignmentExpression':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'AssignmentPattern':
      if (position.key === 'left') return false;
      break;
    case 'UpdateExpression':
      return false;
  }
  const { key } = frame;
  const parent = frame.parent!.node;
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

// ---- call graph facts -------------------------------------------------------

/** `f`, `a.b.c`, `this.m` — or undefined for computed / dynamic callees. */
function calleeName(callee: Node): string | undefined {
  const n = unwrap(callee.type === 'ChainExpression' ? callee.expression : callee);
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') {
    const object = calleeName(n.object);
    return object && `${object}.${n.property.name}`;
  }
  return undefined;
}

function importBindings(program: Node): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const st of program.body as Node[]) {
    if (st.type !== 'ImportDeclaration' || st.importKind === 'type') continue;
    for (const spec of st.specifiers as Node[]) {
      if (spec.importKind === 'type') continue;
      const imported =
        spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.type === 'ImportNamespaceSpecifier' ? '*' : (spec.imported.name ?? spec.imported.value);
      out.push({ local: spec.local.name, imported, source: st.source.value });
    }
  }
  return out;
}

// ---- helpers ----------------------------------------------------------------

function intersects(a: Range, b: Range): boolean {
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  return a.start < b.end && b.start < a.end;
}

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
