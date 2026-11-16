import { defineMutator, definePlugin } from './plugin.ts';
import type { MutatorDefinition, MutatorPlugin } from './types.ts';

export interface NumericMutationOptions {
  rounding?: boolean;
  constants?: readonly { from: number; to: readonly number[] }[];
}

/** Opt-in numeric fault models; constants are supplied by the project. */
export function numericMutations(options: NumericMutationOptions): MutatorPlugin {
  const numberText = (value: number) => Object.is(value, -0) ? '-0' : String(value);
  const constants = new Map<string, Set<string>>();
  for (const rule of options.constants ?? []) {
    if (![rule.from, ...rule.to].every(Number.isFinite)) throw new TypeError('numeric mutations require finite constants');
    const original = numberText(rule.from);
    const replacements = constants.get(original) ?? new Set<string>();
    for (const value of rule.to) if (!Object.is(value, rule.from)) replacements.add(numberText(value));
    constants.set(original, replacements);
  }
  const mutators: MutatorDefinition[] = [];
  if (options.rounding) mutators.push(defineMutator({
    name: 'MathRounding',
    visit(node) {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed) return;
      const { object, property } = node.callee;
      const methods = ['floor', 'ceil', 'round', 'trunc'];
      if (object.type !== 'Identifier' || object.name !== 'Math' || property.type !== 'Identifier' || !methods.includes(property.name)) return;
      return methods.filter((method) => method !== property.name).map((replacement) => ({ range: { start: property.start, end: property.end }, replacement }));
    },
  }));
  if (constants.size) mutators.push(defineMutator({
    name: 'NumericConstant',
    cacheKey: JSON.stringify([...constants].map(([from, to]) => [from, [...to]])),
    visit(node, context) {
      let value: number;
      if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+') && node.argument.type === 'Literal' && typeof node.argument.value === 'number') value = node.operator === '-' ? -node.argument.value : node.argument.value;
      else if (node.type === 'Literal' && typeof node.value === 'number') {
        if (context.parent?.type === 'UnaryExpression' && (context.parent.operator === '-' || context.parent.operator === '+')) return;
        value = node.value;
      } else return;
      return [...(constants.get(numberText(value)) ?? [])].map((replacement) => ({ replacement }));
    },
  }));
  return definePlugin({ name: 'numeric', mutators });
}
