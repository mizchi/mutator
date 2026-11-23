// What a run is set up from: the target files with their mutants, the plugins, and the runner
// with the options its sessions are created with.
import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type CallGraphSource, type InstrumentFlags, type InstrumentOptions, type SkippedCandidate, DEFAULT_ARID_CALLEES, hash, instrument, relativePath as relative } from '@mizchi/mutator-core';
import { isFile } from './child-process.ts';
import type { SourceInfo } from './coverage-cache.ts';
import { loadPlugins } from './plugins.ts';
import type { RunOptions } from './run.ts';
import { type Runner, type RunnerSessionOptions, detectRunner } from './runner.ts';

const DEFAULT_INCLUDE = ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];
// What the instrumenter parses; `--include 'dir/**'` also matches directories and other files.
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/*.d.ts', '**/*.{test,spec}.*', '**/__tests__/**'];
/** `bun test` also collects `*_test.*` and `*_spec.*` files: they are tests, not sources. */
const BUN_TEST_EXCLUDE = ['**/*_{test,spec}.*'];

/** Target files, plugins, and the runner with the options its sessions are created with. */
export async function resolveSetup(root: string, options: RunOptions, log: (message: string) => void) {
  if (options.maxWorkers !== undefined && (!Number.isSafeInteger(options.maxWorkers) || options.maxWorkers < 1)) {
    throw new RangeError('maxWorkers must be a positive safe integer');
  }
  const plugins = await loadPlugins(root, options.plugins ?? []);
  const arid = combineArid(options.arid, plugins.aridCallees);
  const instrumentOptions: InstrumentFlags = {
    ...(options.weakMutation === false ? { weak: false } : {}),
    ...(options.skipSubsumed ? { subsumeCoarse: true } : {}),
    ...(options.minimalRelational ? { minimalRelational: true } : {}),
    ...(arid !== undefined ? { arid } : {}),
    ...(plugins.mutators.length ? { mutators: plugins.mutators } : {}),
    ...(plugins.ignorers.length ? { ignorers: plugins.ignorers } : {}),
    ...(options.excludedMutators?.length ? { excludedMutators: options.excludedMutators } : {}),
  };
  // An explicit runner config picks the runner (the first set, in this order); otherwise
  // detect it from the project.
  const configs: Record<Runner, string | undefined> = { jest: options.jestConfigFile, bun: options.bunConfigFile, playwright: options.playwrightConfigFile, vitest: options.configFile };
  const runner: Runner =
    options.runner && options.runner !== 'auto' ? options.runner : ((Object.keys(configs) as Runner[]).find((r) => configs[r]) ?? detectRunner(root));
  const files = globSync([...(options.include ?? DEFAULT_INCLUDE)], {
    cwd: root,
    exclude: [...DEFAULT_EXCLUDE, ...(runner === 'bun' ? BUN_TEST_EXCLUDE : []), ...(options.exclude ?? [])],
  }).map((f) => join(root, f)).filter((f) => SOURCE_FILE.test(f) && isFile(f));
  const configFile = configs[runner];
  const workerLimit = options.maxWorkers === undefined ? '' : ` (total test worker limit: ${options.maxWorkers})`;
  log(`runner: ${runner}${workerLimit}`);
  const sessionOptions: RunnerSessionOptions = {
    root,
    targets: new Set(files),
    ...(options.maxWorkers !== undefined ? { maxWorkers: options.maxWorkers } : {}),
    ...instrumentOptions,
    pluginModules: plugins.modules,
    hasPluginObjects: plugins.hasObjects,
    ...(runner === 'playwright' && options.playwrightSourceCoverage !== undefined ? { sourceCoverage: options.playwrightSourceCoverage } : {}),
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
  const sourceHashes: Record<string, string> = {};
  const skipped: SkippedCandidate[] = [];
  const mutants = files.flatMap((file) => {
    const content = readFileSync(file, 'utf8');
    const identity = relative(root, file);
    sourceHashes[identity] = hash(content);
    const result = instrument(file, content, { identity, ...instrumentOptions });
    sources.set(file, { scopes: result.scopes, imports: result.imports, reexports: result.reexports, loads: result.loads });
    graphSources.push({ file, scopes: result.scopes, calls: result.calls, imports: result.imports });
    skipped.push(...result.skipped);
    return result.mutants;
  });
  return { mutants, skipped, sources, graphSources, sourceHashes };
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '/index.ts', '/index.js'];

/**
 * Relative import specifier -> one of the mutated files (TS-style `.js` -> `.ts` included);
 * with `onDisk`, any existing file.
 */
export function importResolver(files: readonly string[], onDisk = false) {
  const key = (file: string) => process.platform === 'win32' ? file.replaceAll('\\', '/').toLowerCase() : file;
  const known = new Map(files.map((file) => [key(file), file]));
  const found = (path: string) => known.get(key(path)) ?? (onDisk && isFile(path) ? path : undefined);
  return (from: string, specifier: string): string | undefined => {
    if (!specifier.startsWith('.')) return undefined;
    const base = join(dirname(from), specifier);
    const stems = [base, base.replace(/\.(c|m)?js$/, '.$1ts').replace(/\.jsx$/, '.tsx')];
    for (const stem of stems) for (const suffix of RESOLVE_SUFFIXES) {
      const file = found(stem + suffix);
      if (file) return file;
    }
    return undefined;
  };
}
