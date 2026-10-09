// Test-runner selection and session creation. Adapters are imported lazily so a
// Vitest project never loads the Jest adapter (and vice versa).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { InstrumentOptions, Session } from '@mizchi/mutator-core';

export type Runner = 'vitest' | 'jest';

const EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
const VITEST_CONFIGS = ['vitest', 'vite'].flatMap((name) => EXTENSIONS.map((ext) => `${name}.config.${ext}`));
const JEST_CONFIGS = [...EXTENSIONS, 'json'].map((ext) => `jest.config.${ext}`);

/** vitest / jest config files in the root decide; otherwise whichever runner resolves from the root. */
export function detectRunner(root: string): Runner {
  if (VITEST_CONFIGS.some((f) => existsSync(join(root, f)))) return 'vitest';
  if (JEST_CONFIGS.some((f) => existsSync(join(root, f))) || hasJestField(root)) return 'jest';
  if (resolves(root, 'vitest/package.json')) return 'vitest';
  if (resolves(root, 'jest/package.json')) return 'jest';
  throw new Error(`no test runner found: neither vitest nor jest resolves from ${root}`);
}

function hasJestField(root: string): boolean {
  try {
    return 'jest' in (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as object);
  } catch {
    return false;
  }
}

function resolves(root: string, specifier: string): boolean {
  try {
    createRequire(join(root, 'package.json')).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

export interface RunnerSessionOptions extends Pick<InstrumentOptions, 'arid' | 'mutators' | 'ignorers' | 'excludedMutators'> {
  root: string;
  /** Absolute paths of the sources to mutate. */
  targets: ReadonlySet<string>;
  configFile?: string;
  /** Absolute paths of the plugin modules behind `mutators` / `ignorers`. */
  pluginModules: readonly string[];
  /** Plugins given as objects cannot reach a runner in another process. */
  hasPluginObjects: boolean;
  /** Vitest only: worker threads per session. */
  maxWorkers?: number;
}

export async function createRunnerSession(runner: Runner, options: RunnerSessionOptions): Promise<Session> {
  const { root, targets, configFile, maxWorkers, pluginModules, hasPluginObjects, ...instrument } = options;
  if (runner === 'vitest') {
    const { createSession } = await import('@mizchi/mutator-vitest');
    return createSession({
      root,
      include: (file) => targets.has(file),
      ...instrument,
      ...(configFile ? { configFile } : {}),
      ...(maxWorkers ? { maxWorkers } : {}),
    });
  }
  if (hasPluginObjects) throw new Error('jest: plugins must be modules (paths or package names); plugin objects cannot reach the Jest processes');
  const { createJestSession } = await import('@mizchi/mutator-jest');
  return createJestSession({
    root,
    targets: [...targets],
    ...instrument,
    ...(pluginModules.length ? { pluginModules } : {}),
    ...(configFile ? { configFile } : {}),
  });
}
