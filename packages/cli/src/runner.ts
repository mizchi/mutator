// Test-runner selection and session creation. Adapters are imported lazily so a
// Vitest project never loads the Jest or Playwright adapter (and so on).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { InstrumentOptions, Session } from '@mizchi/mutator-core';

export type Runner = 'vitest' | 'jest' | 'playwright';

const EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
const VITEST_CONFIGS = ['vitest', 'vite'].flatMap((name) => EXTENSIONS.map((ext) => `${name}.config.${ext}`));
const JEST_CONFIGS = [...EXTENSIONS, 'json'].map((ext) => `jest.config.${ext}`);
const PLAYWRIGHT_CONFIGS = EXTENSIONS.map((ext) => `playwright.config.${ext}`);

/**
 * Config files in the root decide, vitest (or vite) first, then jest, then playwright; otherwise
 * whichever runner resolves from the root, vite-plus counting as vitest (it ships vitest as its
 * own dependency). An app with a vite.config and Playwright tests therefore needs `--runner playwright`.
 */
export function detectRunner(root: string): Runner {
  if (VITEST_CONFIGS.some((f) => existsSync(join(root, f)))) return 'vitest';
  if (JEST_CONFIGS.some((f) => existsSync(join(root, f))) || hasJestField(root)) return 'jest';
  if (PLAYWRIGHT_CONFIGS.some((f) => existsSync(join(root, f)))) return 'playwright';
  if (resolves(root, 'vitest/package.json') || resolves(root, 'vite-plus/package.json')) return 'vitest';
  if (resolves(root, 'jest/package.json')) return 'jest';
  if (resolves(root, '@playwright/test/package.json')) return 'playwright';
  throw new Error(`no test runner found: none of vitest (or vite-plus), jest or @playwright/test resolves from ${root}`);
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

export interface RunnerSessionOptions extends Pick<InstrumentOptions, 'arid' | 'mutators' | 'ignorers' | 'excludedMutators' | 'weak'> {
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
  if (hasPluginObjects) throw new Error(`${runner}: plugins must be modules (paths or package names); plugin objects cannot reach the ${runner === 'jest' ? 'Jest processes' : 'dev server'}`);
  if (runner === 'playwright') {
    const { createPlaywrightSession } = await import('@mizchi/mutator-playwright/session');
    return createPlaywrightSession({
      root,
      targets: [...targets],
      ...instrument,
      ...(pluginModules.length ? { pluginModules } : {}),
      ...(configFile ? { configFile } : {}),
    });
  }
  const { createJestSession } = await import('@mizchi/mutator-jest');
  return createJestSession({
    root,
    targets: [...targets],
    ...instrument,
    ...(pluginModules.length ? { pluginModules } : {}),
    ...(configFile ? { configFile } : {}),
  });
}
