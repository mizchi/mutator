// Placement rules: where a mutant switch can wrap code without changing its meaning.
import { type Frame, type Node, isFunction, isSuperCall, isSuperConstructor, outermost, walk } from './ast.ts';
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
    if (isFunction(parent.node)) return isSuperConstructor(parent, node) || redeclaresFunction(node) ? undefined : 'body';
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
  // Directives never get here: walk() skips them.
  if (node.type === 'ExpressionStatement' && isSuperCall(node.expression)) return false;
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

/**
 * A function body whose top-level function declaration shares its name with another one or with a
 * `var`: valid there, but the body placement nests the body in a block, where function declarations
 * are lexical and that is a redeclaration (`var g; function g() {}`).
 */
function redeclaresFunction(body: Node): boolean {
  const functions = (body.body as Node[]).filter((st) => st.type === 'FunctionDeclaration' && st.id && st.body).map((st) => st.id.name as string);
  if (functions.length === 0) return false;
  if (new Set(functions).size < functions.length) return true;
  const names = new Set(functions);
  let found = false;
  walk(body, ({ node }) => {
    if (found || (node !== body && (isFunction(node) || node.type === 'ClassBody'))) return false;
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      found = node.declarations.some((declarator: Node) => bindingNames(declarator.id).some((name) => names.has(name)));
    }
  });
  return found;
}

/** The names a binding pattern declares; default values (`[x = g]`) and computed keys are not bindings. */
function bindingNames(pattern: Node | null): string[] {
  if (!pattern) return [];
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];
    case 'ArrayPattern':
      return pattern.elements.flatMap(bindingNames);
    case 'ObjectPattern':
      return pattern.properties.flatMap((p: Node) => bindingNames(p.type === 'RestElement' ? p : p.value));
    case 'RestElement':
      return bindingNames(pattern.argument);
    case 'AssignmentPattern':
      return bindingNames(pattern.left);
    default:
      return [];
  }
}
