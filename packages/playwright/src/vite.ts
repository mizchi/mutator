// Vite plugin for the app's dev server. Without MUTATOR_PLAYWRIGHT it does nothing, so it
// can stay in the config; mutator starts the dev server with it set, and then the target files
// are served with every mutant compiled in. Which one is active is decided in the page.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { type InstrumentOptions, instrument, loadInstrumentFlags } from '@mizchi/mutator-core';
import { SETTINGS_ENV, type Settings } from './env.ts';

/** The subset of Vite's Plugin this needs (no dependency on vite's types). */
export interface MutatorVitePlugin {
  name: string;
  enforce: 'pre';
  transform(this: unknown, code: string, id: string): Promise<{ code: string; map: unknown } | undefined>;
}

export function mutatorVite(): MutatorVitePlugin {
  const path = process.env[SETTINGS_ENV];
  const setup = path ? load(path) : undefined;
  // A broken settings file fails the first transform, not the server's start-up.
  setup?.catch(() => {});
  return {
    name: 'mutator:instrument',
    enforce: 'pre',
    async transform(code, id) {
      if (!setup) return undefined;
      const { settings, targets, options } = await setup;
      const file = id.split('?')[0]!;
      if (!targets.has(file)) return undefined;
      const result = instrument(file, code, { ...options, identity: relative(settings.root, file) });
      return { code: result.code, map: result.map };
    },
  };
}

async function load(path: string): Promise<{ settings: Settings; targets: Set<string>; options: InstrumentOptions }> {
  const settings = JSON.parse(readFileSync(path, 'utf8')) as Settings;
  return { settings, targets: new Set(settings.targets), options: await loadInstrumentFlags(settings) };
}
