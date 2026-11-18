import { type InstrumentOptions, type Mutant, instrument, instrumentFlags, relativePath as relative } from '@mizchi/mutator-core';
import { isAbsolute, normalize } from 'node:path';
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

/**
 * Vite ids use `/` even on Windows, while callers often build paths with `path.join`.
 * Try the raw id first so filters written against `/` keep working, then the native form.
 */
function isIncluded(include: PluginOptions['include'], file: string): boolean {
  if (include(file)) return true;
  if (!isAbsolute(file)) return false;
  const native = normalize(file);
  return native !== file && include(native);
}

export function mutatorPlugin(registry: MutantRegistry, options: PluginOptions): Plugin {
  return {
    name: 'mutator:instrument',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!;
      if (!SOURCE.test(file) || file.includes('/node_modules/') || !isIncluded(options.include, file)) return;
      const result = instrument(file, code, { ...instrumentFlags(options), ...(options.root ? { identity: relative(options.root, file) } : {}) });
      registry.byFile.set(file, result.mutants);
      return { code: result.code, map: result.map };
    },
  };
}
