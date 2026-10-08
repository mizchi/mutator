import { type Frame, type Node, isFunction, unwrap } from './ast.ts';
import { regexMutations } from './regex.ts';
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

/** Index of `char` at or after `from`, skipping only whitespace and comments; -1 if something else comes first. */
function nextToken(source: string, from: number, char: string): number {
  let i = from;
  while (i < source.length) {
    if (source[i] === char) return i;
    if (/\s/.test(source[i]!)) i++;
    else if (source.startsWith('//', i)) {
      const nl = source.slice(i).search(/[\n\r\u2028\u2029]/);
      if (nl < 0) return -1;
      i += nl;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 2;
    } else return -1;
  }
  return -1;
}

/** `for (init; ; update)` -> `for (init;false ; update)`: insert into the empty test slot. */
function emptyForTest(frame: Frame, ctx: MutatorContext): Candidate[] {
  const { node } = frame;
  let from: number;
  if (node.init) {
    from = node.init.end;
  } else {
    const paren = nextToken(ctx.source, node.start + 'for'.length, '(');
    if (paren < 0) return [];
    from = paren + 1;
  }
  const semi = nextToken(ctx.source, from, ';');
  if (semi < 0) return [];
  return [{ mutator: 'ConditionalExpression', range: { start: semi + 1, end: semi + 1 }, replacement: 'false', anchor: frame }];
}

const conditionalExpression: Mutator = (frame, ctx) => {
  const { node, parent } = frame;
  if (!parent) return [];
  if (node.type === 'ForStatement' && node.test == null) return emptyForTest(frame, ctx);
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

/**
 * `call();` -> `;`. Stryker's "empty expression statement". `throw` statements are deliberately
 * not mutated: removing a throw mostly duplicates the guarding ConditionalExpression mutants.
 * The instrumenter drops these when another mutant lies inside the statement (redundancy filter).
 */
const callExpression: Mutator = (frame) => {
  const { node } = frame;
  if (node.type !== 'ExpressionStatement' || typeof node.directive === 'string') return [];
  let expr = unwrap(node.expression);
  if (expr.type === 'ChainExpression') expr = expr.expression;
  if (expr.type !== 'CallExpression' || expr.callee.type === 'Super') return [];
  return [whole(frame, 'CallExpression', ';')];
};

const regex: Mutator = (frame, ctx) => {
  const { node } = frame;
  if (node.type === 'Literal' && node.regex) {
    const raw = ctx.slice(node);
    const slash = raw.lastIndexOf('/');
    const flags = raw.slice(slash + 1);
    return regexMutations(raw.slice(1, slash), flags)
      .filter((p) => p !== '')
      .map((p) => whole(frame, 'Regex', `/${p}/${flags}`));
  }
  if ((node.type === 'NewExpression' || node.type === 'CallExpression') && node.callee.type === 'Identifier' && node.callee.name === 'RegExp') {
    const [arg, flagsArg] = node.arguments as Node[];
    if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') return [];
    // Unknown flags: keep only patterns valid both with and without unicode mode.
    const flagSets = flagsArg === undefined ? [''] : flagsArg.type === 'Literal' && typeof flagsArg.value === 'string' ? [flagsArg.value] : ['', 'u'];
    const [first = '', ...rest] = flagSets;
    const patterns = regexMutations(arg.value, first).filter((p) => rest.every((f) => regexMutations(arg.value, f).includes(p)));
    const anchor: Frame = { node: arg, parent: frame, key: 'arguments', index: 0 };
    return patterns.map((p) => ({ mutator: 'Regex', range: { start: arg.start, end: arg.end }, replacement: JSON.stringify(p), anchor }));
  }
  return [];
};

// ---- FnValue (cargo-mutants): replace a function body by a value of its declared return type ----

const ARRAY_TYPES = new Set(['Array', 'ReadonlyArray']);

/** JS expressions inhabiting a TS type, derived syntactically. Unknown types yield nothing. */
function typeValues(type: Node, ctx: MutatorContext): string[] {
  switch (type.type) {
    case 'TSParenthesizedType':
      return typeValues(type.typeAnnotation, ctx);
    case 'TSBooleanKeyword':
      return ['true', 'false'];
    case 'TSTypePredicate':
      return type.asserts ? [] : ['true', 'false'];
    case 'TSNumberKeyword':
      return ['0', '1', '-1'];
    case 'TSStringKeyword':
      return ['""', '"xyzzy"'];
    case 'TSBigIntKeyword':
      return ['0n', '1n'];
    case 'TSNullKeyword':
      return ['null'];
    case 'TSUndefinedKeyword':
    case 'TSVoidKeyword':
      return ['undefined'];
    case 'TSArrayType':
      return ['[]'];
    case 'TSTypeOperator':
      return type.operator === 'readonly' && type.typeAnnotation.type === 'TSArrayType' ? ['[]'] : [];
    case 'TSTypeReference':
      return type.typeName.type === 'Identifier' && ARRAY_TYPES.has(type.typeName.name) ? ['[]'] : [];
    case 'TSLiteralType': {
      const lit = type.literal;
      if (lit.type === 'Literal') return [typeof lit.value === 'string' ? JSON.stringify(lit.value) : ctx.slice(lit)];
      if (lit.type === 'UnaryExpression') return [ctx.slice(lit)];
      if (lit.type === 'TemplateLiteral' && lit.expressions.length === 0) return [JSON.stringify(lit.quasis[0]?.value.cooked ?? '')];
      return [];
    }
    case 'TSUnionType':
      return [...new Set((type.types as Node[]).flatMap((t) => typeValues(t, ctx)))];
    default:
      return [];
  }
}

function promiseArgument(type: Node): Node | undefined {
  if (type.type === 'TSParenthesizedType') return promiseArgument(type.typeAnnotation);
  if (type.type !== 'TSTypeReference' || type.typeName.type !== 'Identifier' || type.typeName.name !== 'Promise') return undefined;
  return type.typeArguments?.params?.[0];
}

function sameValue(expr: Node, value: string, ctx: MutatorContext): boolean {
  const n = unwrap(expr);
  if (n.type === 'Literal' && typeof n.value === 'string') return JSON.stringify(n.value) === value;
  return ctx.slice(n).replace(/\s+/g, '') === value.replace(/\s+/g, '');
}

const ACCESSOR_KINDS = new Set(['constructor', 'get', 'set']);

const fnValue: Mutator = (frame, ctx) => {
  const { node, parent } = frame;
  if (!isFunction(node) || !node.returnType || !node.body || node.generator) return [];
  const owner = parent?.node;
  if (owner && (owner.type === 'MethodDefinition' || owner.type === 'Property') && ACCESSOR_KINDS.has(owner.kind)) return [];
  const type: Node = node.returnType.typeAnnotation;
  const promised = promiseArgument(type);
  let values: string[];
  if (node.async) {
    if (!promised) return [];
    values = typeValues(promised, ctx);
  } else if (promised) {
    values = typeValues(promised, ctx).map((v) => `Promise.resolve(${v})`);
  } else {
    values = typeValues(type, ctx);
  }
  const body: Node = node.body;
  const anchor: Frame = { node: body, parent: frame, key: 'body', index: undefined };
  const range = { start: body.start, end: body.end };
  if (body.type === 'BlockStatement') {
    const only = body.body.length === 1 && body.body[0].type === 'ReturnStatement' ? (body.body[0].argument as Node | null) : undefined;
    return (
      values
        // `{ return undefined; }` behaves like BlockStatement's `{}`.
        .filter((v) => v !== 'undefined' && !(only && sameValue(only, v, ctx)))
        .map((v) => ({ mutator: 'FnValue', range, replacement: `{ return ${v}; }`, anchor }))
    );
  }
  return values.filter((v) => !sameValue(body, v, ctx)).map((v) => ({ mutator: 'FnValue', range, replacement: v, anchor }));
};

export const mutators: readonly Mutator[] = [
  arithmeticOperator,
  arrayDeclaration,
  arrowFunction,
  assignmentOperator,
  blockStatement,
  booleanLiteral,
  callExpression,
  conditionalExpression,
  equalityOperator,
  logicalOperator,
  methodExpression,
  objectLiteral,
  optionalChaining,
  regex,
  stringLiteral,
  unaryOperator,
  updateOperator,
  // Last: on an identical edit the established mutator keeps the name.
  fnValue,
];
