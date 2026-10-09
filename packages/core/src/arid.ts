// Arid node suppression (Google, "Practical Mutation Testing at Scale"):
// a simple node is arid when an expert rule says so, a compound node when all
// of its parts are. Mutants anchored in arid code are reported but not run.
import type { Frame, Node } from './ast.ts';

export interface AridOptions {
  /**
   * Callee patterns: `console.*` (first segment), `*.debug` (last segment),
   * `debug` (exact). Calls matching any pattern are logging-like.
   */
  callees?: readonly string[];
}

export const DEFAULT_ARID_CALLEES: readonly string[] = ['console.*', 'logger.*', 'log.*', '*.debug', '*.trace', 'debug'];

function calleePath(callee: Node, source: string): string | undefined {
  let n = callee;
  while (n.type === 'ParenthesizedExpression' || n.type === 'ChainExpression' || n.type === 'TSNonNullExpression') n = n.expression;
  if (n.type !== 'Identifier' && n.type !== 'MemberExpression') return undefined;
  if (n.type === 'MemberExpression' && n.computed) return undefined;
  return source
    .slice(n.start, n.end)
    .replace(/\s+/g, '')
    .replace(/\?\./g, '.')
    .replace(/^this\./, '');
}

function matcher(patterns: readonly string[]): (path: string) => boolean {
  const tests = patterns.map((p) => {
    if (p.endsWith('.*')) {
      const head = p.slice(0, -2);
      return (path: string) => path === head || path.startsWith(`${head}.`) || path.split('.').slice(0, -1).includes(head);
    }
    if (p.startsWith('*.')) {
      const tail = p.slice(2);
      return (path: string) => path.endsWith(`.${tail}`);
    }
    return (path: string) => path === p;
  });
  return (path) => tests.some((t) => t(path));
}

export function createAridCheck(source: string, options: AridOptions = {}): (anchor: Frame) => boolean {
  const isLoggingPath = matcher(options.callees ?? DEFAULT_ARID_CALLEES);
  const memo = new Map<Node, boolean>();

  const isLoggingCall = (node: Node): boolean => {
    let n = node;
    while (n.type === 'ChainExpression' || n.type === 'ParenthesizedExpression' || n.type === 'AwaitExpression') n = n.expression ?? n.argument;
    if (n.type !== 'CallExpression') return false;
    const path = calleePath(n.callee, source);
    return path !== undefined && isLoggingPath(path);
  };

  const aridStatement = (node: Node | null | undefined): boolean => {
    if (!node) return true;
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    let result: boolean;
    switch (node.type) {
      case 'ExpressionStatement':
        result = isLoggingCall(node.expression);
        break;
      case 'BlockStatement':
        result = node.body.length > 0 && node.body.every((s: Node) => aridStatement(s));
        break;
      case 'IfStatement':
        result = aridStatement(node.consequent) && aridStatement(node.alternate);
        break;
      case 'EmptyStatement':
        result = true;
        break;
      default:
        result = false;
    }
    memo.set(node, result);
    return result;
  };

  return (anchor) => {
    for (let f: Frame | undefined = anchor; f; f = f.parent) {
      const { node } = f;
      if (node.type === 'CallExpression' && isLoggingCall(node)) return true;
      if ((node.type === 'ExpressionStatement' || node.type === 'BlockStatement' || node.type === 'IfStatement') && aridStatement(node)) {
        // An empty function body is not "logging only".
        return !(node.type === 'BlockStatement' && node.body.length === 0);
      }
      if (node.type.endsWith('Statement') || node.type.endsWith('Declaration')) {
        if (node.type !== 'ExpressionStatement' && node.type !== 'BlockStatement' && node.type !== 'IfStatement') return false;
      }
      if (node.type === 'Program' || node.type.includes('Function')) return false;
    }
    return false;
  };
}
