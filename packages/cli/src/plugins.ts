// Loads plugin modules: relative paths from the project root, or package names
// resolved from it. A module's default export may be a plugin, a mutator, an
// ignorer, or an array of them.
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import {
  type MutantIgnorer,
  type MutatorDefinition,
  type MutatorPlugin,
  PluginError,
  addPluginExport,
  emptyPluginParts,
  hash,
  loadPluginModule,
} from '@mizchi/mutator-core';
import { ConfigError } from './config.ts';

export type PluginSpec = string | MutatorPlugin | MutatorDefinition | MutantIgnorer;

export interface LoadedPlugins {
  mutators: MutatorDefinition[];
  ignorers: MutantIgnorer[];
  aridCallees: string[];
  /** Absolute paths of the plugin modules (runners in other processes load them themselves). */
  modules: string[];
  /** Whether some plugins were passed as objects (not loadable in another process). */
  hasObjects: boolean;
  /** Changes when a plugin's code changes; part of the environment hash. */
  fingerprint: string;
}

export async function loadPlugins(root: string, specs: readonly PluginSpec[]): Promise<LoadedPlugins> {
  const parts = emptyPluginParts();
  const prints: string[] = [];
  const modules: string[] = [];
  let hasObjects = false;
  for (const spec of specs) {
    try {
      if (typeof spec !== 'string') {
        addPluginExport(parts, spec, 'object');
        hasObjects = true;
        continue;
      }
      const file = spec.startsWith('.') || isAbsolute(spec) ? join(root, spec) : resolvePackage(root, spec);
      modules.push(file);
      prints.push(`${spec}:${await loadPluginModule(parts, file, spec)}`);
    } catch (error) {
      throw error instanceof PluginError ? new ConfigError(error.message, { cause: error }) : error;
    }
  }
  const { mutators, ignorers, aridCallees } = parts;
  // Plugin objects have no module to hash: their code is the fingerprint.
  prints.push(...mutators.map((m) => `${m.name}:${m.visit.toString()}`), ...ignorers.map((i) => `ignorer:${i.name}:${i.shouldIgnore.toString()}`), `arid:${aridCallees.join(',')}`);
  return { mutators, ignorers, aridCallees, modules, hasObjects, fingerprint: hash(prints.join('\0')) };
}

function resolvePackage(root: string, spec: string): string {
  try {
    return createRequire(join(root, 'package.json')).resolve(spec);
  } catch (error) {
    throw new ConfigError(`plugin ${spec}: cannot resolve it from ${root}`, { cause: error });
  }
}
