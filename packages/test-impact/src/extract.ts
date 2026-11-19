import { type Node, walk, isFunction } from './ast.ts';
import { parseSource } from './parse.ts';
import { ScopeTracker, isTopLevelScope, topLevelInfo, normalize } from './scope.ts';
import { lineStarts, position } from './text.ts';
import { hash } from './hash.ts';
import type { Location, Range } from './types.ts';

export function createScopeTracker(source: string, program: Node, comments: readonly Range[]): ScopeTracker {
  const { literals, functions } = collectRanges(program);
  return new ScopeTracker(source, (node, includeNested) => {
    const nested = includeNested ? [] : functions.filter(f => f.start !== node.start || f.end !== node.end);
    return hash(normalize(source, node, comments, literals, nested));
  });
}

export interface SourceScope {
  id: string;
  hash: string;
  range: Range;
  location: Location;
  declares?: string[];
}

export function extractScopes(file: string, source: string): SourceScope[] {
  const parsed = parseSource(file, source, { preserveParens: true });
  if (parsed.errors.length) throw new Error(`Failed to parse ${file}: ${parsed.errors[0]!.message}`);
  const program = parsed.program as unknown as Node;
  const tracker = createScopeTracker(source, program, parsed.comments);
  const lines = lineStarts(source);
  const scopes: SourceScope[] = [];
  walk(program, frame => {
    if (!tracker.enter(frame, 0)) return;
    const { node, id } = tracker.current!;
    scopes.push({ id, ...(isTopLevelScope(id) ? { declares: topLevelInfo(node).declares } : {}), hash: tracker.hashOf(node), range: { start: node.start, end: node.end },
      location: { start: position(lines, node.start), end: position(lines, node.end) } });
  }, frame => { if (tracker.current?.node === frame.node) tracker.leave(); });
  return scopes;
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

