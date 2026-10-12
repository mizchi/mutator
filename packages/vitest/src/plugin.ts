import { type InstrumentOptions, type Mutant, instrument } from '@mizchi/mutator-core';
import { relative } from 'node:path';
import type { Plugin } from 'vitest/config';

export interface PluginOptions {
  /** Absolute file path filter for sources to mutate. */
  include: (file: string) => boolean;
  excludedMutators?: InstrumentOptions['excludedMutators'];
  arid?: InstrumentOptions['arid'];
  mutators?: InstrumentOptions['mutators'];
  ignorers?: InstrumentOptions['ignorers'];
  weak?: InstrumentOptions['weak'];
  /** Mutant identity uses paths relative to this directory. */
  root?: string;
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
      const result = instrument(file, code, {
        ...(options.excludedMutators ? { excludedMutators: options.excludedMutators } : {}),
        ...(options.arid !== undefined ? { arid: options.arid } : {}),
        ...(options.mutators ? { mutators: options.mutators } : {}),
        ...(options.ignorers ? { ignorers: options.ignorers } : {}),
        ...(options.weak !== undefined ? { weak: options.weak } : {}),
        ...(options.root ? { identity: relative(options.root, file) } : {}),
      });
      registry.byFile.set(file, result.mutants);
      return { code: result.code, map: result.map };
    },
  };
}
