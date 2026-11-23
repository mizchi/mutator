// The subsumption-minimal replacement set for relational operators (Kaminski, Ammann and Offutt,
// "Better predicate testing", 2011), and lower bounds that prove some replacements equivalent.
import { type Node, unwrap } from './ast.ts';

export type Relational = '<' | '<=' | '>' | '>=';

const RELATIONAL = new Set<string>(['<', '<=', '>', '>=']);
export const isRelational = (op: string): op is Relational => RELATIONAL.has(op);

/**
 * Each operator's minimal set: the two operator replacements, and the one constant. Together they
 * are killed by exactly the tests that kill all seven relational replacements.
 */
export const MINIMAL: Record<Relational, { operators: [string, string]; constant: 'true' | 'false' }> = {
  '<': { operators: ['<=', '!='], constant: 'false' },
  '<=': { operators: ['<', '=='], constant: 'true' },
  '>': { operators: ['>=', '!='], constant: 'false' },
  '>=': { operators: ['>', '=='], constant: 'true' },
};

const MIRROR: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=', '===': '===', '!==': '!==' };

/** Methods that return an index or -1. */
const INDEX_METHODS = new Set(['indexOf', 'lastIndexOf', 'findIndex', 'findLastIndex', 'search']);

/**
 * The integer lower bound of an expression known syntactically: `.length` and `.size` are >= 0
 * (`split(...).length` >= 1),
 * index lookups (`indexOf`, `findIndex`, `search`, ...) are >= -1. Heuristic: a custom object can
 * define these names otherwise.
 */
export function lowerBound(node: Node): number | undefined {
  const n = unwrap(node);
  if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') {
    if (n.property.name === 'size') return 0;
    if (n.property.name !== 'length') return undefined;
    // `s.split(x)` always has at least one element (`"".split("@")` is `[""]`).
    const object = unwrap(n.object);
    const callee = object.type === 'CallExpression' ? unwrap(object.callee) : undefined;
    return callee?.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'split' ? 1 : 0;
  }
  if (n.type === 'CallExpression') {
    const callee = unwrap(n.callee);
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && INDEX_METHODS.has(callee.property.name)) return -1;
  }
  return undefined;
}

function numberLiteral(node: Node): number | undefined {
  const n = unwrap(node);
  if (n.type === 'Literal' && typeof n.value === 'number') return n.value;
  if (n.type === 'UnaryExpression' && (n.operator === '-' || n.operator === '+')) {
    const v = numberLiteral(n.argument);
    return v === undefined ? undefined : n.operator === '-' ? -v : v;
  }
  return undefined;
}

const compare = (op: string, x: number, c: number): boolean => {
  switch (op) {
    case '<': return x < c;
    case '<=': return x <= c;
    case '>': return x > c;
    case '>=': return x >= c;
    case '==': case '===': return x === c;
    case '!=': case '!==': return x !== c;
    default: throw new Error(`not a comparison: ${op}`);
  }
};

/**
 * Whether replacing comparison `node` (`<bounded> op <literal>`, either side) by `to` (an operator
 * or a constant) gives the same value for every integer the bounded side can take. Exact: two
 * comparisons against the same literal can only disagree at the literal or next to it.
 */
export function equivalentUnderBound(node: Node, to: string): boolean {
  if (node.type !== 'BinaryExpression' || !Object.hasOwn(MIRROR, node.operator)) return false;
  let op = node.operator as string;
  let bounded = lowerBound(node.left);
  let c = numberLiteral(node.right);
  let mutated = to;
  if (bounded === undefined || c === undefined) {
    // `0 <= s.length`: read it as `s.length >= 0`.
    bounded = lowerBound(node.right);
    c = numberLiteral(node.left);
    if (bounded === undefined || c === undefined) return false;
    op = MIRROR[op]!;
    if (Object.hasOwn(MIRROR, to)) mutated = MIRROR[to]!;
  }
  const lo = bounded;
  const points = new Set([lo, lo + 1, Math.floor(c) - 1, Math.floor(c), Math.ceil(c), Math.ceil(c) + 1, 2 ** 31]);
  for (const x of points) {
    if (x < lo) continue;
    const before = compare(op, x, c);
    const after = mutated === 'true' ? true : mutated === 'false' ? false : compare(mutated, x, c);
    if (before !== after) return false;
  }
  return true;
}
