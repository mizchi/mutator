import { visitorKeys } from 'oxc-parser';
import type { AstNode } from './types.ts';

export type Node = AstNode;

export interface Frame {
  node: Node;
  parent: Frame | undefined;
  /** Property name in the parent (`body`, `left`, ...). */
  key: string;
  /** Index when the parent property is an array. */
  index: number | undefined;
}

/** Keys that only hold type-level syntax. */
const TYPE_KEYS = new Set([
  'typeAnnotation',
  'returnType',
  'typeParameters',
  'typeArguments',
  'superTypeArguments',
  'implements',
  'decorators',
]);

/** TS nodes that wrap runtime expressions and must be traversed. */
const TS_RUNTIME = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
  'TSParameterProperty',
  'TSExportAssignment',
]);

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

/** Nodes whose subtree contains no mutable runtime code. */
function isSkippedNode(node: Node): boolean {
  if (node.type.startsWith('TS')) return !TS_RUNTIME.has(node.type);
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'Decorator':
      return true;
    case 'ExportNamedDeclaration':
      return node.source != null || node.exportKind === 'type';
    case 'VariableDeclaration':
    case 'ClassDeclaration':
    case 'PropertyDefinition':
      return node.declare === true;
    case 'FunctionDeclaration':
      return node.declare === true || node.body == null;
    case 'ExpressionStatement':
      return isDirective(node);
    default:
      return false;
  }
}

function childFrames(frame: Frame): Frame[] {
  const node = frame.node;
  const keys = visitorKeys[node.type] ?? [];
  const out: Frame[] = [];
  for (const key of keys) {
    if (TYPE_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        if (isNode(child)) out.push({ node: child, parent: frame, key, index });
      });
    } else if (isNode(value)) {
      out.push({ node: value, parent: frame, key, index: undefined });
    }
  }
  return out;
}

/** Depth-first pre-order walk over runtime syntax. `visit` returning false skips children. */
export function walk(root: Node, visit: (frame: Frame) => boolean | void, leave?: (frame: Frame) => void): void {
  const go = (frame: Frame) => {
    if (isSkippedNode(frame.node)) return;
    if (visit(frame) === false) return;
    for (const child of childFrames(frame)) go(child);
    leave?.(frame);
  };
  go({ node: root, parent: undefined, key: '', index: undefined });
}

export function isFunction(node: Node): boolean {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  );
}

/** A prologue directive such as `'use strict'`. */
export function isDirective(node: Node): boolean {
  return node.type === 'ExpressionStatement' && typeof node.directive === 'string';
}

export function isSuperCall(node: Node): boolean {
  return node.type === 'CallExpression' && node.callee.type === 'Super';
}

/** `body` is the body of the class constructor `fn` and calls `super()` at its top level. */
export function isSuperConstructor(fn: Frame, body: Node): boolean {
  return fn.parent?.node.type === 'MethodDefinition' && fn.parent.node.kind === 'constructor' && body.body.some((st: Node) => st.type === 'ExpressionStatement' && isSuperCall(st.expression));
}

/** Wrappers that leave their expression's runtime value and position unchanged. */
export const TRANSPARENT: ReadonlySet<string> = new Set(['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);

/** Strip TRANSPARENT wrappers. */
export function unwrap(node: Node): Node {
  let n = node;
  while (TRANSPARENT.has(n.type)) n = n.expression;
  return n;
}

/**
 * The outermost TRANSPARENT wrapper around a node (the frame itself when unwrapped): its parent and
 * key are the position the node really occupies, e.g. `(o?.m)()` puts `o?.m` in callee position.
 */
export function outermost(frame: Frame): Frame {
  let f = frame;
  while (f.parent && TRANSPARENT.has(f.parent.node.type)) f = f.parent;
  return f;
}
