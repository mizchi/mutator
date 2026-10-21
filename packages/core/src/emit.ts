// Emission: wraps placed nodes in mutant switches with coverage and weak-mutation probes.
import type MagicString from 'magic-string';
import { type Frame, type Node, isDirective, outermost } from './ast.ts';
import type { Placement } from './placement.ts';
import { RUNTIME_ACTIVE, RUNTIME_COLLECT, RUNTIME_COV, RUNTIME_HIT, RUNTIME_WEAK } from './runtime.ts';
import type { Mutant } from './types.ts';

export function emitPlacement(s: MagicString, source: string, { frame, kind, mutants }: Placement, placements: ReadonlyMap<Node, Placement>, indexOf: ReadonlyMap<string, number>, weakProbes: boolean): void {
  const node = frame.node;
  const mutated = (m: Mutant) => source.slice(node.start, m.range.start) + m.replacement + source.slice(m.range.end, node.end);
  const act = (m: Mutant) => `${RUNTIME_ACTIVE} === ${JSON.stringify(m.key)} && ${RUNTIME_HIT}()`;
  const weak = weakProbes && kind === 'expression' ? weakChecks(frame, source, mutants, mutated, indexOf) : [];
  const cov = `${RUNTIME_COLLECT} && (${[`${RUNTIME_COV}(${mutants.map((m) => indexOf.get(m.key)).join(', ')})`, ...weak].join(', ')})`;
  let prefix: string;
  let suffix: string;
  switch (kind) {
    case 'expression':
      prefix = `(${mutants.map((m) => `${act(m)} ? (${mutated(m)}) : `).join('')}(${cov}, (`;
      suffix = ')))';
      if (needsAsiGuard(frame, placements)) prefix = `;${prefix}`;
      break;
    case 'statement':
      prefix = `{${mutants.map((m, i) => `${i ? 'else ' : ''}if (${act(m)}) {${mutated(m)}} `).join('')}else {${cov}; `;
      suffix = '}}';
      break;
    case 'body': {
      const directives = node.body
        .filter(isDirective)
        .map((st: Node) => source.slice(st.start, st.end))
        .join(' ');
      prefix = `{${directives}${mutants.map((m, i) => `${i ? 'else ' : ''}if (${act(m)}) ${mutated(m)} `).join('')}else {${cov}; `;
      suffix = '}}';
      break;
    }
  }
  s.appendRight(node.start, prefix);
  s.prependLeft(node.end, suffix);
}

const WEAK_MUTATORS = new Set(['EqualityOperator', 'ArithmeticOperator', 'ConditionalExpression']);
const WEAK_OPERATORS = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!==', '+', '-', '*', '/', '%']);

/** Expressions that can be evaluated again without any observable effect. */
function isPure(node: Node): boolean {
  switch (node.type) {
    case 'Identifier':
    case 'ThisExpression':
      return true;
    case 'Literal':
      return !node.regex; // a regex literal is a new object on every evaluation
    case 'ParenthesizedExpression':
      return isPure(node.expression);
    case 'UnaryExpression':
      return ['-', '+', '!', '~', 'typeof'].includes(node.operator) && isPure(node.argument);
    case 'TemplateLiteral':
      return node.expressions.length === 0;
    case 'MemberExpression':
      // `.length` of a binding: strings and arrays, no getters in practice.
      return !node.computed && node.property.name === 'length' && node.object.type === 'Identifier';
    default:
      return false;
  }
}

/**
 * Weak-mutation probes for mutants that replace the whole placed expression and
 * whose original and mutated forms can both be re-evaluated without side effects.
 * Only runs in dry runs (behind the collect flag). Both forms are evaluated in
 * place: being side-effect free, the only possible exception (TDZ, `.length` of
 * null) is the one the original expression throws right after anyway.
 */
function weakChecks(frame: Frame, source: string, mutants: readonly Mutant[], mutated: (m: Mutant) => string, indexOf: ReadonlyMap<string, number>): string[] {
  const node = frame.node;
  const inner = unwrapParens(node);
  const pure = (inner.type === 'BinaryExpression' && WEAK_OPERATORS.has(inner.operator) && isPure(inner.left) && isPure(inner.right)) || isPure(inner);
  if (!pure) return [];
  const testPosition = isTestPosition(frame);
  const wrap = (code: string) => (testPosition ? `!!(${code})` : `(${code})`);
  const original = source.slice(node.start, node.end);
  const args: string[] = [];
  for (const m of mutants) {
    if (!WEAK_MUTATORS.has(m.mutator) || m.range.start !== node.start || m.range.end !== node.end) continue;
    // `a * b` -> `a / b` can throw where the original does not (BigInt division by zero);
    // every other swap keeps the operand types, so it throws only when the original does.
    if (m.mutator === 'ArithmeticOperator' && inner.type === 'BinaryExpression' && inner.operator === '*') continue;
    m.weak = true;
    args.push(`${indexOf.get(m.key)}, ${wrap(mutated(m))}`);
  }
  // One call per evaluation: the original value, then (mutant index, mutated value) pairs.
  return args.length ? [`${RUNTIME_WEAK}(${wrap(original)}, ${args.join(', ')})`] : [];
}

// Parentheses only, like isPure: a probe re-evaluates the source text, and TS wrappers are not proven pure here.
function unwrapParens(node: Node): Node {
  return node.type === 'ParenthesizedExpression' ? unwrapParens(node.expression) : node;
}

/** The value is only used for its truthiness (if / loop / ternary test). */
function isTestPosition(frame: Frame): boolean {
  const f = outermost(frame);
  const parent = f.parent?.node;
  return f.key === 'test' && parent !== undefined && ['IfStatement', 'WhileStatement', 'DoWhileStatement', 'ForStatement', 'ConditionalExpression'].includes(parent.type);
}

/** An expression statement in a statement list that would now start with `(` (outermost placement only). */
function needsAsiGuard(frame: Frame, placements: ReadonlyMap<Node, Placement>): boolean {
  const start = frame.node.start;
  for (let f = frame.parent; f && f.node.start === start; f = f.parent) {
    if (placements.has(f.node)) return false;
    if (f.node.type === 'ExpressionStatement') return f.index !== undefined;
    if (f.node.type.endsWith('Statement') || f.node.type.endsWith('Declaration')) return false;
  }
  return false;
}

export function headerInsertion(program: Node, runtimeHeader: string): { at: number; text: string } {
  const directives = (program.body as Node[]).filter(isDirective);
  const last = directives.at(-1);
  if (last) return { at: last.end, text: `\n${runtimeHeader}` };
  if (program.hashbang) return { at: program.hashbang.end, text: `\n${runtimeHeader}` };
  return { at: 0, text: `${runtimeHeader}\n` };
}
