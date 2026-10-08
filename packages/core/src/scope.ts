import { type Frame, type Node, isFunction } from './ast.ts';
import type { Range } from './types.ts';

export interface ScopeInfo {
  id: string;
  node: Node;
  /** Depth of the frame path where this scope starts (for relative AST paths). */
  depth: number;
}

const WORD = /[\p{L}\p{N}_$]/u;
const SIGN = /[+-]/;

/**
 * Normalize source for hashing: drop comments and insignificant whitespace,
 * keep string / template contents verbatim. Whitespace that can change meaning
 * survives: line breaks (ASI) and spaces between words or between `+` / `-`.
 */
export function normalize(source: string, range: Range, comments: readonly Range[], literals: readonly Range[], holes: readonly Range[] = []): string {
  const skip = comments.filter((c) => c.start >= range.start && c.end <= range.end);
  const keep = literals.filter((l) => l.start >= range.start && l.end <= range.end);
  const gaps = holes.filter((h) => h.start >= range.start && h.end <= range.end);
  let out = '';
  let gap: '' | ' ' | '\n' = '';
  const emit = (text: string) => {
    const prev = out.at(-1) ?? '';
    const next = text[0] ?? '';
    if (gap === '\n' && out) out += '\n';
    else if (gap === ' ' && ((WORD.test(prev) && WORD.test(next)) || (SIGN.test(prev) && SIGN.test(next)))) out += ' ';
    gap = '';
    out += text;
  };
  let i = range.start;
  let ci = 0;
  let li = 0;
  let hi = 0;
  while (i < range.end) {
    while (ci < skip.length && skip[ci]!.end <= i) ci++;
    while (li < keep.length && keep[li]!.end <= i) li++;
    while (hi < gaps.length && gaps[hi]!.start < i) hi++;
    const h = gaps[hi];
    if (h && h.start === i) {
      emit('\u0192');
      i = h.end;
      continue;
    }
    const c = skip[ci];
    if (c && c.start === i) {
      if (gap === '') gap = ' ';
      i = c.end;
      continue;
    }
    const l = keep[li];
    if (l && l.start === i) {
      emit(source.slice(l.start, l.end));
      i = l.end;
      continue;
    }
    const ch = source[i]!;
    if (ch === '\n') gap = '\n';
    else if (/\s/.test(ch)) {
      if (gap === '') gap = ' ';
    } else emit(ch);
    i++;
  }
  return out;
}

function keyName(key: Node, source: string): string {
  if (key.type === 'Identifier' || key.type === 'PrivateIdentifier') return (key.type === 'PrivateIdentifier' ? '#' : '') + key.name;
  if (key.type === 'Literal') return String(key.value);
  return `[${source.slice(key.start, key.end)}]`;
}

/** Position independent name of a function-like node, or undefined when anonymous. */
export function functionName(frame: Frame, source: string): string | undefined {
  const { node } = frame;
  if (node.id?.type === 'Identifier') return node.id.name;
  const parent = frame.parent?.node;
  if (!parent) return undefined;
  switch (parent.type) {
    case 'VariableDeclarator':
      return parent.id.type === 'Identifier' ? parent.id.name : undefined;
    case 'MethodDefinition':
    case 'PropertyDefinition':
    case 'Property': {
      const name = keyName(parent.key, source);
      const kind = parent.kind === 'get' || parent.kind === 'set' ? `${parent.kind} ` : '';
      return kind + name;
    }
    case 'AssignmentExpression':
      return source.slice(parent.left.start, parent.left.end).replace(/\s+/g, '');
    default:
      return undefined;
  }
}

/**
 * Name of the class or object literal owning a method / property function,
 * e.g. `K` for `class K { m() {} }` and `api` for `const api = { run() {} }`.
 */
export function ownerName(frame: Frame, source: string): string | undefined {
  const parent = frame.parent;
  if (!parent) return undefined;
  if (parent.node.type === 'MethodDefinition' || parent.node.type === 'PropertyDefinition') {
    const cls = parent.parent?.parent;
    if (!cls) return undefined;
    if (cls.node.id) return cls.node.id.name;
    return cls.parent ? functionName(cls, source) : undefined;
  }
  if (parent.node.type === 'Property' && parent.parent?.node.type === 'ObjectExpression') {
    return objectName(parent.parent, source);
  }
  return undefined;
}

function objectName(object: Frame, source: string): string | undefined {
  const holder = object.parent;
  if (!holder) return undefined;
  switch (holder.node.type) {
    case 'VariableDeclarator':
      return holder.node.id.type === 'Identifier' ? holder.node.id.name : undefined;
    case 'AssignmentExpression':
      return source.slice(holder.node.left.start, holder.node.left.end).replace(/\s+/g, '');
    case 'ExportDefaultDeclaration':
      return 'default';
    case 'Property': {
      const outer = holder.parent && objectName(holder.parent, source);
      const key = keyName(holder.node.key, source);
      return outer ? `${outer}.${key}` : key;
    }
    default:
      return undefined;
  }
}

export class ScopeTracker {
  private readonly stack: ScopeInfo[] = [];
  private readonly used = new Map<string, number>();
  private readonly anonCounters = new Map<string, number>();

  private readonly source: string;
  private readonly scopeHash: (node: Node) => string;

  constructor(source: string, scopeHash: (node: Node) => string) {
    this.source = source;
    this.scopeHash = scopeHash;
  }

  get current(): ScopeInfo | undefined {
    return this.stack.at(-1);
  }

  /** Call on entering a node; returns true when the node opened a new scope. */
  enter(frame: Frame, depth: number): boolean {
    const { node } = frame;
    let id: string | undefined;
    if (isFunction(node)) {
      const parentId = this.current && !this.current.id.startsWith('<top') ? this.current.id : '';
      let name = functionName(frame, this.source);
      const owner = ownerName(frame, this.source);
      if (name && owner) name = `${owner}.${name}`;
      if (!name) {
        const n = (this.anonCounters.get(parentId) ?? 0) + 1;
        this.anonCounters.set(parentId, n);
        name = `<anon${n}>`;
      }
      id = parentId ? `${parentId}>${name}` : name;
    } else if (frame.parent?.node.type === 'Program' && !this.current) {
      id = `<top:${this.scopeHash(node).slice(0, 6)}>`;
    }
    if (id === undefined) return false;
    const seen = (this.used.get(id) ?? 0) + 1;
    this.used.set(id, seen);
    if (seen > 1) id = `${id}#${seen}`;
    this.stack.push({ id, node, depth });
    return true;
  }

  leave(): void {
    this.stack.pop();
  }

  hashOf(node: Node): string {
    return this.scopeHash(node);
  }
}

