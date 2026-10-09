// Loads plugin modules: relative paths from the project root, or package names
// resolved from it. A module's default export may be a plugin, a mutator, an
// ignorer, or an array of them.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type MutantIgnorer, type MutatorDefinition, type MutatorPlugin, hash } from '@mizchi/mutator-core';

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

const isMutator = (value: unknown): value is MutatorDefinition =>
  typeof value === 'object' && value !== null && typeof (value as MutatorDefinition).visit === 'function';
const isIgnorer = (value: unknown): value is MutantIgnorer =>
  typeof value === 'object' && value !== null && typeof (value as MutantIgnorer).shouldIgnore === 'function';

export async function loadPlugins(root: string, specs: readonly PluginSpec[]): Promise<LoadedPlugins> {
  const mutators: MutatorDefinition[] = [];
  const ignorers: MutantIgnorer[] = [];
  const aridCallees: string[] = [];
  const prints: string[] = [];
  const modules: string[] = [];
  let hasObjects = false;
  const add = (value: unknown, origin: string): void => {
    if (Array.isArray(value)) return value.forEach((v) => add(v, origin));
    if (isMutator(value)) {
      mutators.push(value);
      prints.push(`${value.name}:${value.visit.toString()}`);
      return;
    }
    if (isIgnorer(value)) {
      ignorers.push(value);
      prints.push(`ignorer:${value.name}:${value.shouldIgnore.toString()}`);
      return;
    }
    if (typeof value === 'object' && value !== null && typeof (value as MutatorPlugin).name === 'string') {
      const plugin = value as MutatorPlugin;
      for (const m of plugin.mutators ?? []) add(m, origin);
      for (const i of plugin.ignorers ?? []) add(i, origin);
      aridCallees.push(...(plugin.aridCallees ?? []));
      prints.push(`plugin:${plugin.name}:${(plugin.aridCallees ?? []).join(',')}`);
      return;
    }
    throw new Error(`plugin ${origin}: expected a plugin, a mutator, an ignorer or an array of them as the default export`);
  };

  for (const spec of specs) {
    if (typeof spec !== 'string') {
      add(spec, 'object');
      hasObjects = true;
      continue;
    }
    const file = spec.startsWith('.') || isAbsolute(spec) ? join(root, spec) : resolvePackage(root, spec);
    const content = readFileSync(file, 'utf8');
    modules.push(file);
    prints.push(`${spec}:${hash(content)}`);
    // The content hash busts the ESM cache when a plugin is edited between runs in one process.
    const module = await import(`${pathToFileURL(file).href}?v=${hash(content)}`);
    add(module.default ?? module, spec);
  }
  return { mutators, ignorers, aridCallees, modules, hasObjects, fingerprint: hash(prints.join('\0')) };
}

function resolvePackage(root: string, spec: string): string {
  try {
    return createRequire(join(root, 'package.json')).resolve(spec);
  } catch (error) {
    throw new Error(`plugin ${spec}: cannot resolve it from ${root}`, { cause: error });
  }
}
