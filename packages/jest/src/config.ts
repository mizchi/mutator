// Reads the project's Jest config with its own jest-config and derives the config
// the mutator runs Jest with: every transform wrapped by our transformer, our
// runtime setup in front of setupFiles / setupFilesAfterEnv.
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InstrumentOptions } from '@mizchi/mutator-core';

// Published builds run from dist/; the CommonJS helpers ship in src/.
const own = (name: string) => fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? `./${name}` : `../src/${name}`, import.meta.url));
export const TRANSFORMER = own('transformer.cjs');
export const SETUP_FILE = own('setup.cjs');
export const HOOKS_FILE = own('hooks.cjs');

/** Jest's own default pattern for JavaScript / TypeScript. */
const SOURCE_PATTERN = '\\.[cm]?[jt]sx?$';

export interface JestProject {
  /** `jest/bin/jest.js` resolved from the project root. */
  bin: string;
  /** The project's config file, if any. */
  configPath: string | undefined;
  /** Raw (un-normalized) options as written by the user, with an absolute rootDir. */
  raw: Record<string, unknown>;
  /** Normalized transform entries: [pattern, absolute transformer path, options]. */
  transform: [string, string, unknown][];
  /** Absolute setupFiles / setupFilesAfterEnv / globalSetup / globalTeardown of the project. */
  setupFiles: string[];
}

interface JestConfigModule {
  readInitialOptions(config: string | undefined, options: { packageRootOrConfig: string }): Promise<{ config: Record<string, unknown>; configPath: string | null }>;
  normalize(options: Record<string, unknown>, argv: Record<string, unknown>): Promise<{ options: Record<string, unknown> }>;
}

export async function readJestProject(root: string, configFile?: string): Promise<JestProject> {
  let jestPackage: string;
  try {
    jestPackage = createRequire(join(root, 'package.json')).resolve('jest/package.json');
  } catch (error) {
    throw new Error(`mutator: cannot resolve jest from ${root}`, { cause: error });
  }
  const fromJest = createRequire(jestPackage);
  const jestConfig = createRequire(fromJest.resolve('jest-cli/package.json'))('jest-config') as JestConfigModule;
  const { config: raw, configPath } = await jestConfig.readInitialOptions(configFile, { packageRootOrConfig: configFile ?? root });
  if (raw.projects) throw new Error('mutator: Jest `projects` are not supported');
  const { options } = await jestConfig.normalize(raw, {});
  const setupFiles = ['setupFiles', 'setupFilesAfterEnv', 'globalSetup', 'globalTeardown'].flatMap((key) => [options[key] ?? []].flat() as string[]);
  return {
    bin: join(dirname(jestPackage), 'bin', 'jest.js'),
    configPath: configPath && isAbsolute(configPath) && !configPath.endsWith('package.json') ? configPath : undefined,
    raw,
    transform: (options.transform as [string, string, unknown][] | undefined) ?? [],
    setupFiles: setupFiles.filter((f) => typeof f === 'string' && isAbsolute(f)),
  };
}

export interface TransformerConfig {
  inner: [string, unknown] | null;
  root: string;
  targets: string[];
  pluginModules: string[];
  arid?: InstrumentOptions['arid'];
  excludedMutators?: readonly string[];
}

export function mutatorJestConfig(project: JestProject, transformer: Omit<TransformerConfig, 'inner'>, cacheDirectory: string): Record<string, unknown> {
  const transform: Record<string, [string, TransformerConfig]> = {};
  const entries: [string, string | null, unknown][] = project.transform.length > 0 ? project.transform : [[SOURCE_PATTERN, null, {}]];
  for (const [pattern, path, options] of entries) {
    transform[pattern] = [TRANSFORMER, { ...transformer, inner: path ? [path, options] : null }];
  }
  const list = (key: string) => [project.raw[key] ?? []].flat();
  return {
    ...project.raw,
    transform,
    setupFiles: [SETUP_FILE, ...list('setupFiles')],
    setupFilesAfterEnv: [HOOKS_FILE, ...list('setupFilesAfterEnv')],
    cacheDirectory,
    watchman: false,
    collectCoverage: false,
  };
}
