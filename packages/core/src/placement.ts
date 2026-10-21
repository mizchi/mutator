// Placement rules: where a mutant switch can wrap code without changing its meaning.
import { type Frame, type Node, isDirective, isFunction, isSuperCall, isSuperConstructor, outermost } from './ast.ts';
import type { Mutant } from './types.ts';

type PlacementKind = 'expression' | 'statement' | 'body';

export interface Placement {
  frame: Frame;
  kind: PlacementKind;
  mutants: Mutant[];
}

export function findPlacement(anchor: Frame): { frame: Frame; kind: PlacementKind } | undefined {
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
    if (isDirective(node)) return false;
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

/** The position a node really occupies: `(o?.m)()` puts `o?.m` in callee position. */
function effectivePosition(frame: Frame): { parent: Node; key: string } {
  const f = outermost(frame);
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
  // Rules on the direct parent; the positional ones above already cover it when it is not transparent.
  const { key } = frame;
  const parent = frame.parent!.node;
  switch (parent.type) {
    case 'TaggedTemplateExpression':
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
