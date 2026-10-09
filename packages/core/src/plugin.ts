import type { Frame } from './ast.ts';
import type { Candidate, MutatorContext } from './mutators.ts';
import { BUILTIN_MUTATOR_NAMES, type MutatorDefinition, type MutatorPlugin } from './types.ts';

export const defineMutator = (definition: MutatorDefinition): MutatorDefinition => definition;
export const definePlugin = (plugin: MutatorPlugin): MutatorPlugin => plugin;

const BUILTIN = new Set<string>(BUILTIN_MUTATOR_NAMES);

/** Adapt a custom mutator to the engine's internal mutator signature. */
export function adaptMutator(definition: MutatorDefinition, file: string): (frame: Frame, ctx: MutatorContext) => Candidate[] {
  if (BUILTIN.has(definition.name)) throw new Error(`custom mutator "${definition.name}" shadows a built-in mutator`);
  return (frame, ctx) => {
    const { node } = frame;
    let specs;
    try {
      specs = definition.visit(node, { source: ctx.source, parent: frame.parent?.node, key: frame.key, text: ctx.slice });
    } catch (error) {
      throw new Error(`mutator ${definition.name} failed on ${file} at offset ${node.start}: ${(error as Error).message}`, { cause: error });
    }
    if (!specs) return [];
    return specs.map((spec) => {
      const range = spec.range ?? { start: node.start, end: node.end };
      if (range.start < node.start || range.end > node.end || range.start > range.end) {
        throw new Error(`mutator ${definition.name} returned range ${range.start}-${range.end} outside the visited ${node.type} (${node.start}-${node.end}) in ${file}`);
      }
      return { mutator: definition.name, range, replacement: spec.replacement, anchor: frame };
    });
  };
}
