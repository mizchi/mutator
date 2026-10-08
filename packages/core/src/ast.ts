import { visitorKeys } from 'oxc-parser';

export interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: any;
}

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

export function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

/** Nodes whose subtree contains no mutable runtime code. */
export function isSkippedNode(node: Node): boolean {
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
      return typeof node.directive === 'string';
    default:
      return false;
  }
}

export function childFrames(frame: Frame): Frame[] {
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

/** Strip ParenthesizedExpression / TS expression wrappers. */
export function unwrap(node: Node): Node {
  let n = node;
  while (
    n.type === 'ParenthesizedExpression' ||
    n.type === 'TSAsExpression' ||
    n.type === 'TSSatisfiesExpression' ||
    n.type === 'TSNonNullExpression' ||
    n.type === 'TSTypeAssertion'
  ) {
    n = n.expression;
  }
  return n;
}
