import { type Frame, type Node, isFunction, unwrap } from './ast.ts';
import type { MutatorName, Range } from './types.ts';

export interface Candidate {
  mutator: MutatorName;
  range: Range;
  replacement: string;
  /** Node from which the placement search starts. */
  anchor: Frame;
}

export interface MutatorContext {
  source: string;
  slice(node: Node | Range): string;
}

type Mutator = (frame: Frame, ctx: MutatorContext) => Candidate[];

/** Own-property lookup so names like `toString` never hit Object.prototype. */
const lookup = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

const whole = (frame: Frame, mutator: MutatorName, replacement: string): Candidate => ({
  mutator,
  range: { start: frame.node.start, end: frame.node.end },
  replacement,
  anchor: frame,
});

/** Replace the operator token between `left` and `right`. */
function swapOperator(frame: Frame, ctx: MutatorContext, mutator: MutatorName, from: string, to: string, logical = false): Candidate {
  const { node } = frame;
  // `??` cannot be mixed with `&&` / `||` without parentheses, so logical operands are wrapped.
  const operand = (n: Node) => (logical && n.type === 'LogicalExpression' ? `(${ctx.slice(n)})` : ctx.slice(n));
  const gap = ctx.slice({ start: node.left.end, end: node.right.start });
  const text = ctx.slice({ start: node.start, end: node.left.start }) + operand(node.left) + gap.replace(from, to) + operand(node.right) + ctx.slice({ start: node.right.end, end: node.end });
  return whole(frame, mutator, logical ? `(${text})` : text);
}

const isStringy = (node: Node): boolean => {
  const n = unwrap(node);
  return (n.type === 'Literal' && typeof n.value === 'string') || n.type === 'TemplateLiteral';
};

const ARITHMETIC: Record<string, string> = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' };

const arithmeticOperator: Mutator = (frame, ctx) => {
  const { node } = frame;
  if (node.type !== 'BinaryExpression') return [];
  const to = lookup(ARITHMETIC, node.operator);
  if (!to) return [];
  if (node.operator === '+') {
    const leftmost = unwrap(node.left).type === 'BinaryExpression' ? unwrap(node.left).right : node.left;
    if (isStringy(node.right) || isStringy(node.left) || isStringy(leftmost)) return [];
  }
  return [swapOperator(frame, ctx, 'ArithmeticOperator', node.operator, to)];
};

const EQUALITY: Record<string, string[]> = {
  '<': ['<=', '>='],
  '<=': ['<', '>'],
  '>': ['>=', '<='],
  '>=': ['>', '<'],
  '==': ['!='],
  '!=': ['=='],
  '===': ['!=='],
  '!==': ['==='],
};

const equalityOperator: Mutator = (frame, ctx) => {
  const { node } = frame;
  if (node.type !== 'BinaryExpression') return [];
  return (lookup(EQUALITY, node.operator) ?? []).map((to) => swapOperator(frame, ctx, 'EqualityOperator', node.operator, to));
};

const LOGICAL: Record<string, string> = { '&&': '||', '||': '&&', '??': '&&' };

const logicalOperator: Mutator = (frame, ctx) => {
  const { node } = frame;
  if (node.type !== 'LogicalExpression') return [];
  const to = lookup(LOGICAL, node.operator);
  return to ? [swapOperator(frame, ctx, 'LogicalOperator', node.operator, to, true)] : [];
};

const LOOPS = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement']);
const CONDITIONS = new Set(['IfStatement', 'ConditionalExpression']);

/** Climb through parentheses / TS wrappers. */
function effectiveParent(frame: Frame): Frame | undefined {
  let f = frame.parent;
  let key = frame.key;
  while (f && (f.node.type === 'ParenthesizedExpression' || f.node.type === 'TSAsExpression' || f.node.type === 'TSNonNullExpression' || f.node.type === 'TSSatisfiesExpression')) {
    key = f.key;
    f = f.parent;
  }
  return f && { ...f, key };
}

const conditionalExpression: Mutator = (frame) => {
  const { node, parent } = frame;
  if (!parent) return [];
  const isTest = frame.key === 'test';
  if (isTest && LOOPS.has(parent.node.type)) return [whole(frame, 'ConditionalExpression', 'false')];
  if (isTest && CONDITIONS.has(parent.node.type)) {
    return [whole(frame, 'ConditionalExpression', 'true'), whole(frame, 'ConditionalExpression', 'false')];
  }
  const comparison = node.type === 'BinaryExpression' && Object.hasOwn(EQUALITY, node.operator);
  const logical = node.type === 'LogicalExpression' && node.operator !== '??';
  if (!comparison && !logical) return [];
  // Inside a test position the parent statement already produced these.
  const outer = effectiveParent(frame);
  if (outer?.key === 'test' && (LOOPS.has(outer.node.type) || CONDITIONS.has(outer.node.type))) return [];
  // `a || <x>` with x=true / `a && <x>` with x=false collapse to equivalent-ish mutants of the parent.
  const parentOp = outer?.node.type === 'LogicalExpression' ? outer.node.operator : undefined;
  const out: Candidate[] = [];
  if (parentOp !== '||') out.push(whole(frame, 'ConditionalExpression', 'true'));
  if (parentOp !== '&&') out.push(whole(frame, 'ConditionalExpression', 'false'));
  return out;
};

const booleanLiteral: Mutator = (frame, ctx) => {
  const { node } = frame;
  if (node.type === 'Literal' && typeof node.value === 'boolean') {
    return [whole(frame, 'BooleanLiteral', node.value ? 'false' : 'true')];
  }
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    return [whole(frame, 'BooleanLiteral', ctx.slice(node.argument))];
  }
  return [];
};

const unaryOperator: Mutator = (frame, ctx) => {
  const { node } = frame;
  if (node.type !== 'UnaryExpression') return [];
  const rest = ctx.slice({ start: node.start + 1, end: node.end });
  if (node.operator === '~') return [whole(frame, 'UnaryOperator', rest)];
  const to = node.operator === '+' ? '-' : node.operator === '-' ? '+' : undefined;
  if (!to) return [];
  const sep = /^[+-]/.test(rest) ? ' ' : '';
  return [whole(frame, 'UnaryOperator', `${to}${sep}${rest}`)];
};

const updateOperator: Mutator = (frame, ctx) => {
  const { node } = frame;
  if (node.type !== 'UpdateExpression') return [];
  const to = node.operator === '++' ? '--' : '++';
  return [whole(frame, 'UpdateOperator', ctx.slice(node).replace(node.operator, to))];
};

const ASSIGNMENT: Record<string, string> = {
  '+=': '-=',
  '-=': '+=',
  '*=': '/=',
  '/=': '*=',
  '%=': '*=',
  '<<=': '>>=',
  '>>=': '<<=',
  '&=': '|=',
  '|=': '&=',
  '&&=': '||=',
  '||=': '&&=',
  '??=': '&&=',
};

const assignmentOperator: Mutator = (frame, ctx) => {
  const { node } = frame;
  if (node.type !== 'AssignmentExpression') return [];
  const to = lookup(ASSIGNMENT, node.operator);
  if (!to) return [];
  const logical = node.operator === '&&=' || node.operator === '||=' || node.operator === '??=';
  if (!logical && isStringy(node.right)) return [];
  return [swapOperator(frame, ctx, 'AssignmentOperator', node.operator, to)];
};

const PLACEHOLDER = 'Stryker was here!';

const arrayDeclaration: Mutator = (frame, ctx) => {
  const { node } = frame;
  if (node.type === 'ArrayExpression') {
    return [whole(frame, 'ArrayDeclaration', node.elements.length ? '[]' : `["${PLACEHOLDER}"]`)];
  }
  if ((node.type === 'NewExpression' || node.type === 'CallExpression') && node.callee.type === 'Identifier' && node.callee.name === 'Array') {
    const prefix = node.type === 'NewExpression' ? 'new ' : '';
    return [whole(frame, 'ArrayDeclaration', node.arguments.length ? `${prefix}Array()` : `${prefix}Array([])`)];
  }
  void ctx;
  return [];
};

const objectLiteral: Mutator = (frame) => {
  const { node } = frame;
  return node.type === 'ObjectExpression' && node.properties.length ? [whole(frame, 'ObjectLiteral', '{}')] : [];
};

function stringLiteralExcluded(frame: Frame): boolean {
  const parent = frame.parent?.node;
  if (!parent) return true;
  switch (parent.type) {
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
    case 'ImportExpression':
    case 'JSXAttribute':
    case 'ImportAttribute':
      return true;
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'AccessorProperty':
      return frame.key === 'key' && !parent.computed;
    case 'CallExpression': {
      const callee = parent.callee;
      return callee.type === 'Identifier' && (callee.name === 'require' || callee.name === 'Symbol');
    }
    case 'TaggedTemplateExpression':
      return true;
    default:
      return false;
  }
}

const stringLiteral: Mutator = (frame, ctx) => {
  const { node } = frame;
  if (node.type === 'Literal' && typeof node.value === 'string') {
    if (stringLiteralExcluded(frame)) return [];
    const quote = ctx.source[node.start] === "'" ? "'" : '"';
    return [whole(frame, 'StringLiteral', node.value.length ? `${quote}${quote}` : `${quote}${PLACEHOLDER}${quote}`)];
  }
  if (node.type === 'TemplateLiteral') {
    if (stringLiteralExcluded(frame)) return [];
    const empty = node.expressions.length === 0 && node.quasis.every((q: Node) => q.value.raw === '');
    return [whole(frame, 'StringLiteral', empty ? `\`${PLACEHOLDER}\`` : '``')];
  }
  return [];
};

function hasSuperCall(body: Node): boolean {
  return body.body.some(
    (s: Node) => s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression' && s.expression.callee.type === 'Super',
  );
}

const blockStatement: Mutator = (frame) => {
  const { node, parent } = frame;
  if (node.type !== 'BlockStatement' || node.body.length === 0) return [];
  // Constructors calling super(): emptying them breaks derived classes before any test runs.
  if (parent && isFunction(parent.node) && parent.parent?.node.type === 'MethodDefinition' && parent.parent.node.kind === 'constructor' && hasSuperCall(node)) {
    return [];
  }
  return [whole(frame, 'BlockStatement', '{}')];
};

const arrowFunction: Mutator = (frame) => {
  const { node } = frame;
  if (node.type !== 'ArrowFunctionExpression' || !node.expression) return [];
  const body = unwrap(node.body);
  if (body.type === 'Identifier' && body.name === 'undefined') return [];
  const bodyFrame = { node: node.body, parent: frame, key: 'body', index: undefined };
  return [{ mutator: 'ArrowFunction', range: { start: node.body.start, end: node.body.end }, replacement: 'undefined', anchor: bodyFrame }];
};

const METHOD_REMOVALS = new Set(['charAt', 'filter', 'reverse', 'slice', 'sort', 'substr', 'substring', 'trim']);
const METHOD_SWAPS: Record<string, string> = {
  endsWith: 'startsWith',
  startsWith: 'endsWith',
  every: 'some',
  some: 'every',
  toLocaleLowerCase: 'toLocaleUpperCase',
  toLocaleUpperCase: 'toLocaleLowerCase',
  toLowerCase: 'toUpperCase',
  toUpperCase: 'toLowerCase',
  trimEnd: 'trimStart',
  trimStart: 'trimEnd',
  min: 'max',
  max: 'min',
};

const methodExpression: Mutator = (frame, ctx) => {
  const { node } = frame;
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed) return [];
  const { object, property } = node.callee;
  if (property.type !== 'Identifier') return [];
  const name: string = property.name;
  if (METHOD_REMOVALS.has(name)) return [whole(frame, 'MethodExpression', ctx.slice(object))];
  const swap = lookup(METHOD_SWAPS, name);
  if (swap) return [{ mutator: 'MethodExpression', range: { start: property.start, end: property.end }, replacement: swap, anchor: frame }];
  return [];
};

const optionalChaining: Mutator = (frame, ctx) => {
  const { node } = frame;
  if (!node.optional) return [];
  let from: number;
  if (node.type === 'MemberExpression') from = node.object.end;
  else if (node.type === 'CallExpression') from = node.callee.end;
  else return [];
  const token = ctx.source.indexOf('?.', from);
  if (token < 0) return [];
  const keepDot = node.type === 'MemberExpression' && !node.computed;
  return [{ mutator: 'OptionalChaining', range: { start: token, end: token + 2 }, replacement: keepDot ? '.' : '', anchor: frame }];
};

export const mutators: readonly Mutator[] = [
  arithmeticOperator,
  arrayDeclaration,
  arrowFunction,
  assignmentOperator,
  blockStatement,
  booleanLiteral,
  conditionalExpression,
  equalityOperator,
  logicalOperator,
  methodExpression,
  objectLiteral,
  optionalChaining,
  stringLiteral,
  unaryOperator,
  updateOperator,
];
