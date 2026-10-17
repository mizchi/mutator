// Vite plugin for the app's dev server. Without MUTATOR_PLAYWRIGHT it does nothing, so it
// can stay in the config; mutator starts the dev server with it set, and then the target files
// are served with every mutant compiled in. Which one is active is decided in the page.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type InstrumentOptions, instrument } from '@mizchi/mutator-core';
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
  const { mutators, ignorers } = await loadPlugins(settings.pluginModules);
  return {
    settings,
    targets: new Set(settings.targets),
    options: {
      ...(settings.arid !== undefined ? { arid: settings.arid } : {}),
      ...(settings.excludedMutators ? { excludedMutators: settings.excludedMutators } : {}),
      ...(settings.weak !== undefined ? { weak: settings.weak } : {}),
      ...(mutators.length ? { mutators } : {}),
      ...(ignorers.length ? { ignorers } : {}),
    },
  };
}

type Mutator = NonNullable<InstrumentOptions['mutators']>[number];
type Ignorer = NonNullable<InstrumentOptions['ignorers']>[number];

/** Plugin modules (absolute paths) -> custom mutators and ignorers, like the CLI's loader. */
async function loadPlugins(files: readonly string[]): Promise<{ mutators: Mutator[]; ignorers: Ignorer[] }> {
  const mutators: Mutator[] = [];
  const ignorers: Ignorer[] = [];
  const add = (value: unknown, origin: string): void => {
    if (Array.isArray(value)) return value.forEach((v) => add(v, origin));
    const v = value as { visit?: unknown; shouldIgnore?: unknown; name?: unknown; mutators?: unknown[]; ignorers?: unknown[] } | null;
    if (v && typeof v.visit === 'function') return void mutators.push(v as Mutator);
    if (v && typeof v.shouldIgnore === 'function') return void ignorers.push(v as Ignorer);
    if (v && typeof v.name === 'string') {
      for (const m of v.mutators ?? []) add(m, origin);
      for (const i of v.ignorers ?? []) add(i, origin);
      return;
    }
    throw new Error(`mutator: plugin ${origin} has no plugin, mutator or ignorer as its default export`);
  };
  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    add(mod.default ?? mod, file);
  }
  return { mutators, ignorers };
}
