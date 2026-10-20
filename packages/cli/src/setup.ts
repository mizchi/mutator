// What a run is set up from: the target files with their mutants, the plugins, and the runner
// with the options its sessions are created with.
import { globSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { type CallGraphSource, type InstrumentFlags, type InstrumentOptions, DEFAULT_ARID_CALLEES, instrument } from '@mizchi/mutator-core';
import { isFile } from './child-process.ts';
import type { SourceInfo } from './coverage-cache.ts';
import { loadPlugins } from './plugins.ts';
import type { RunOptions } from './run.ts';
import { type RunnerSessionOptions, detectRunner } from './runner.ts';

const DEFAULT_INCLUDE = ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/*.d.ts', '**/*.{test,spec}.*', '**/__tests__/**'];

/** Target files, plugins, and the runner with the options its sessions are created with. */
export async function resolveSetup(root: string, options: RunOptions, log: (message: string) => void) {
  const files = globSync([...(options.include ?? DEFAULT_INCLUDE)], {
    cwd: root,
    exclude: [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])],
  }).map((f) => join(root, f));
  const plugins = await loadPlugins(root, options.plugins ?? []);
  const arid = combineArid(options.arid, plugins.aridCallees);
  const instrumentOptions: InstrumentFlags = {
    ...(options.weakMutation === false ? { weak: false } : {}),
    ...(arid !== undefined ? { arid } : {}),
    ...(plugins.mutators.length ? { mutators: plugins.mutators } : {}),
    ...(plugins.ignorers.length ? { ignorers: plugins.ignorers } : {}),
    ...(options.excludedMutators?.length ? { excludedMutators: options.excludedMutators } : {}),
  };
  // An explicit runner config picks the runner; otherwise detect it from the project.
  const runner =
    options.runner && options.runner !== 'auto'
      ? options.runner
      : options.jestConfigFile
        ? 'jest'
        : options.playwrightConfigFile
          ? 'playwright'
          : options.configFile
            ? 'vitest'
            : detectRunner(root);
  const configFile = { vitest: options.configFile, jest: options.jestConfigFile, playwright: options.playwrightConfigFile }[runner];
  log(`runner: ${runner}`);
  const sessionOptions: RunnerSessionOptions = {
    root,
    targets: new Set(files),
    ...instrumentOptions,
    pluginModules: plugins.modules,
    hasPluginObjects: plugins.hasObjects,
    ...(configFile ? { configFile } : {}),
  };
  return { files, plugins, arid, instrumentOptions, runner, sessionOptions };
}

/** Plugins' logging patterns extend the arid callees (the defaults, or the configured ones). */
function combineArid(arid: InstrumentOptions['arid'], extra: readonly string[]): InstrumentOptions['arid'] {
  if (arid === false || extra.length === 0) return arid;
  return { callees: [...(arid?.callees ?? DEFAULT_ARID_CALLEES), ...extra] };
}

/** Mutants and scopes of every target file; keys match the ones the Vite plugin produces. */
export function collectSources(root: string, files: readonly string[], instrumentOptions: InstrumentFlags) {
  const sources = new Map<string, SourceInfo>();
  const graphSources: CallGraphSource[] = [];
  const mutants = files.flatMap((file) => {
    const result = instrument(file, readFileSync(file, 'utf8'), { identity: relative(root, file), ...instrumentOptions });
    sources.set(file, { scopes: result.scopes, imports: result.imports, reexports: result.reexports });
    graphSources.push({ file, scopes: result.scopes, calls: result.calls, imports: result.imports });
    return result.mutants;
  });
  return { mutants, sources, graphSources };
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '/index.ts', '/index.js'];

/**
 * Relative import specifier -> one of the mutated files (TS-style `.js` -> `.ts` included);
 * with `onDisk`, any existing file.
 */
export function importResolver(files: readonly string[], onDisk = false) {
  const known = new Set(files);
  const found = (path: string) => known.has(path) || (onDisk && isFile(path));
  return (from: string, specifier: string): string | undefined => {
    if (!specifier.startsWith('.')) return undefined;
    const base = join(dirname(from), specifier);
    const stems = [base, base.replace(/\.(c|m)?js$/, '.$1ts').replace(/\.jsx$/, '.tsx')];
    for (const stem of stems) for (const suffix of RESOLVE_SUFFIXES) if (found(stem + suffix)) return stem + suffix;
    return undefined;
  };
}
