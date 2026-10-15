// Mutants proven equivalent from types. Only `a?.b` -> `a.b` (and `a?.()` / `a?.[k]`)
// when the type of `a` excludes null and undefined. Types say so honestly only with
// strictNullChecks and noUncheckedIndexedAccess: without the latter `xs[0]` is typed
// `string` yet undefined for `[]` (4 such mutants on ufo were all killed).
import type { TypecheckMutant } from './types.ts';

/** The AST surface both the compiler API and the native API offer. */
export interface AstNode {
  readonly end: number;
  readonly questionDotToken?: AstNode | undefined;
  readonly expression?: AstNode;
  getStart(sourceFile?: never): number;
  forEachChild<R>(visit: (node: AstNode) => R): R | undefined;
}

export interface TypeView {
  readonly flags: number;
}

export interface TypeQueries<T extends TypeView> {
  /** Whether strictNullChecks (`undefined` is not assignable to `string`) and noUncheckedIndexedAccess are in effect. */
  honest(): boolean;
  sourceFile(file: string): AstNode | undefined;
  /** Types of `nodes`, in one query where the API allows it. */
  typesAt(nodes: readonly AstNode[]): readonly (T | undefined)[];
  /** Members of a union or intersection. */
  members(type: T): readonly T[];
  /** The `TypeFlags` enum of this TypeScript (values differ between 6 and 7). */
  flags: Record<string, unknown>;
}

// Types whose values are never null or undefined.
const NON_NULLISH = ['String', 'Number', 'BigInt', 'Boolean', 'ESSymbol', 'StringLiteral', 'NumberLiteral', 'BigIntLiteral', 'BooleanLiteral', 'UniqueESSymbol', 'EnumLiteral', 'Enum', 'NonPrimitive', 'Object', 'TemplateLiteral', 'StringMapping'];

/** key -> `equivalent: <a> is never nullish`, for the OptionalChaining mutants of `mutants` it proves. */
export function provenEquivalent<T extends TypeView>(mutants: readonly TypecheckMutant[], read: (file: string) => string, q: TypeQueries<T>): Map<string, string> {
  const result = new Map<string, string>();
  const texts = new Map<string, string>();
  const textOf = (file: string) => texts.get(file) ?? texts.set(file, read(file)).get(file)!;
  const candidates = mutants.filter((m) => m.range.end - m.range.start === 2 && (m.replacement === '.' || m.replacement === '') && textOf(m.file).slice(m.range.start, m.range.end) === '?.');
  if (candidates.length === 0 || !q.honest()) return result;
  const flag = (name: string) => q.flags[name] as number;
  const nonNullish = NON_NULLISH.reduce((mask, name) => mask | flag(name), 0);
  const never = (type: T): boolean => {
    if (type.flags & flag('Union')) return q.members(type).every(never);
    if (type.flags & flag('Intersection')) return q.members(type).some(never);
    return (type.flags & nonNullish) !== 0;
  };
  const byFile = Map.groupBy(candidates, (m) => m.file);
  for (const [file, list] of byFile) {
    const source = q.sourceFile(file);
    if (!source) continue;
    const chains = optionalChains(source);
    const text = textOf(file);
    const found = list.flatMap((m) => {
      const target = chains.get(m.range.start);
      return target ? [{ m, target }] : [];
    });
    const types = q.typesAt(found.map((f) => f.target));
    found.forEach(({ m, target }, i) => {
      const type = types[i];
      if (type && never(type)) result.set(m.key, `equivalent: ${text.slice(target.getStart(), target.end).replace(/\s+/g, ' ')} is never nullish`);
    });
  }
  return result;
}

/** Position of each `?.` -> the expression before it. */
function optionalChains(source: AstNode): Map<number, AstNode> {
  const out = new Map<number, AstNode>();
  const visit = (node: AstNode): undefined => {
    if (node.questionDotToken && node.expression) out.set(node.questionDotToken.end - 2, node.expression);
    node.forEachChild(visit);
    return undefined;
  };
  source.forEachChild(visit);
  return out;
}
