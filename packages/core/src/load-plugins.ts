// Plugin modules -> custom mutators and ignorers. One loader for the CLI and for the runners
// that instrument in another process (Jest's transformer, the Playwright dev server), which
// get the plugins as module paths and so must read them exactly as the CLI does.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hash } from './hash.ts';
import { type InstrumentFlags, type PortableFlags, instrumentFlags, portableFlags } from './runner.ts';
import type { MutantIgnorer, MutatorDefinition, MutatorPlugin } from './types.ts';

/** A plugin module whose export is not a plugin, a mutator or an ignorer. */
export class PluginError extends Error {}

export interface PluginParts {
  mutators: MutatorDefinition[];
  ignorers: MutantIgnorer[];
  aridCallees: string[];
}

export const emptyPluginParts = (): PluginParts => ({ mutators: [], ignorers: [], aridCallees: [] });

const isMutator = (value: unknown): value is MutatorDefinition =>
  typeof value === 'object' && value !== null && typeof (value as MutatorDefinition).visit === 'function';
const isIgnorer = (value: unknown): value is MutantIgnorer =>
  typeof value === 'object' && value !== null && typeof (value as MutantIgnorer).shouldIgnore === 'function';

/** Adds a plugin module's export (a plugin, a mutator, an ignorer, or an array of them) to `parts`. */
export function addPluginExport(parts: PluginParts, value: unknown, origin: string): void {
  if (Array.isArray(value)) return value.forEach((v) => addPluginExport(parts, v, origin));
  if (isMutator(value)) return void parts.mutators.push(value);
  if (isIgnorer(value)) return void parts.ignorers.push(value);
  if (typeof value === 'object' && value !== null && typeof (value as MutatorPlugin).name === 'string') {
    const plugin = value as MutatorPlugin;
    // A named object with none of the parts is a mistake (a misspelt `visit`), not an empty plugin.
    if (!plugin.mutators && !plugin.ignorers && !plugin.aridCallees) {
      throw new PluginError(`plugin ${origin}: ${plugin.name} has no visit (a mutator), shouldIgnore (an ignorer), or mutators / ignorers / aridCallees (a plugin)`);
    }
    for (const m of plugin.mutators ?? []) addPluginExport(parts, m, origin);
    for (const i of plugin.ignorers ?? []) addPluginExport(parts, i, origin);
    parts.aridCallees.push(...(plugin.aridCallees ?? []));
    return;
  }
  throw new PluginError(`plugin ${origin}: expected a plugin, a mutator, an ignorer or an array of them as the default export, each with a name`);
}

/** Imports the plugin module at `file` (an absolute path) into `parts`; returns the hash of its content. */
export async function loadPluginModule(parts: PluginParts, file: string, origin = file): Promise<string> {
  const contentHash = hash(readFileSync(file, 'utf8'));
  // The content hash busts the ESM cache when a plugin is edited between runs in one process.
  const module = (await import(`${pathToFileURL(file).href}?v=${contentHash}`)) as { default?: unknown };
  addPluginExport(parts, module.default ?? module, origin);
  return contentHash;
}

/** Plugin modules (absolute paths) -> their mutators, ignorers and arid callees, in order. */
export async function loadPluginModules(files: readonly string[]): Promise<PluginParts> {
  const parts = emptyPluginParts();
  for (const file of files) await loadPluginModule(parts, file);
  return parts;
}

/**
 * The instrument options of a runner in another process: the session's portable flags and
 * its plugin modules. Plugins' arid callees are left out: the session's `arid` already has them.
 */
export async function loadInstrumentFlags(settings: PortableFlags & { pluginModules?: readonly string[] | undefined }): Promise<InstrumentFlags> {
  const { mutators, ignorers } = await loadPluginModules(settings.pluginModules ?? []);
  return instrumentFlags({
    ...portableFlags(settings),
    ...(mutators.length ? { mutators } : {}),
    ...(ignorers.length ? { ignorers } : {}),
  });
}
