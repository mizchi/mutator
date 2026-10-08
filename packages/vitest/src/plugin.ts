import { type InstrumentOptions, type Mutant, type Range, instrument } from '@mizchi/mutator-core';
import type { Plugin } from 'vitest/config';

export interface PluginOptions {
  /** Absolute file path filter for sources to mutate. */
  include: (file: string) => boolean;
  /** Restrict mutation to these ranges per absolute file path. */
  ranges?: ReadonlyMap<string, readonly Range[]>;
  excludedMutators?: InstrumentOptions['excludedMutators'];
}

const SOURCE = /\.[cm]?[jt]sx?$/;

/** Collects mutants of every module transformed by the plugin. */
export class MutantRegistry {
  readonly byFile = new Map<string, Mutant[]>();

  all(): Mutant[] {
    return [...this.byFile.values()].flat();
  }
}

export function mutatorPlugin(registry: MutantRegistry, options: PluginOptions): Plugin {
  return {
    name: 'mutator:instrument',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!;
      if (!SOURCE.test(file) || file.includes('/node_modules/') || !options.include(file)) return;
      const ranges = options.ranges?.get(file);
      if (options.ranges && !ranges) return;
      const result = instrument(file, code, {
        ...(ranges ? { ranges } : {}),
        ...(options.excludedMutators ? { excludedMutators: options.excludedMutators } : {}),
      });
      registry.byFile.set(file, result.mutants);
      return { code: result.code, map: result.map };
    },
  };
}
