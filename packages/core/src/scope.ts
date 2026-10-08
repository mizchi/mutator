import { type Frame, type Node, isFunction } from './ast.ts';
import type { Range } from './types.ts';

export interface ScopeInfo {
  id: string;
  node: Node;
  /** Depth of the frame path where this scope starts (for relative AST paths). */
  depth: number;
}

const WORD = /[\p{L}\p{N}_$]/u;

/**
 * Normalize source for hashing: drop comments and insignificant whitespace,
 * keep string / template contents verbatim.
 */
export function normalize(source: string, range: Range, comments: readonly Range[], literals: readonly Range[]): string {
  const skip = comments.filter((c) => c.start >= range.start && c.end <= range.end);
  const keep = literals.filter((l) => l.start >= range.start && l.end <= range.end);
  let out = '';
  let pendingSpace = false;
  let i = range.start;
  let ci = 0;
  let li = 0;
  while (i < range.end) {
    while (ci < skip.length && skip[ci]!.end <= i) ci++;
    while (li < keep.length && keep[li]!.end <= i) li++;
    const c = skip[ci];
    if (c && c.start === i) {
      pendingSpace = true;
      i = c.end;
      continue;
    }
    const l = keep[li];
    if (l && l.start === i) {
      if (pendingSpace && WORD.test(out.at(-1) ?? '') && WORD.test(source[i]!)) out += ' ';
      pendingSpace = false;
      out += source.slice(l.start, l.end);
      i = l.end;
      continue;
    }
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && WORD.test(out.at(-1) ?? '') && WORD.test(ch)) out += ' ';
      pendingSpace = false;
      out += ch;
    }
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

/** Name of the class owning a method frame (`MethodDefinition` → `ClassBody` → `Class`). */
export function ownerClassName(frame: Frame, source: string): string | undefined {
  const parent = frame.parent;
  if (!parent || (parent.node.type !== 'MethodDefinition' && parent.node.type !== 'PropertyDefinition')) return undefined;
  const cls = parent.parent?.parent;
  if (!cls) return undefined;
  if (cls.node.id) return cls.node.id.name;
  return cls.parent ? functionName(cls, source) : undefined;
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
      const owner = ownerClassName(frame, this.source);
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

