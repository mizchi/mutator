// Test-runner selection and session creation. Adapters are imported lazily so a
// Vitest project never loads the Jest or Playwright adapter (and so on).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { InstrumentOptions, Session } from '@mizchi/mutator-core';
import { ConfigError } from './config.ts';

export type Runner = 'vitest' | 'jest' | 'playwright';

const EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
const VITEST_CONFIGS = ['vitest', 'vite'].flatMap((name) => EXTENSIONS.map((ext) => `${name}.config.${ext}`));
const JEST_CONFIGS = [...EXTENSIONS, 'json'].map((ext) => `jest.config.${ext}`);
const PLAYWRIGHT_CONFIGS = EXTENSIONS.map((ext) => `playwright.config.${ext}`);

/**
 * Auto selects unit runners only: vitest (or vite) configs first, then jest configs,
 * then installed Vitest / Vite+ or Jest. Browser mutation runs can be slow and require
 * an explicit runner or Playwright config option.
 */
export function detectRunner(root: string): Exclude<Runner, 'playwright'> {
  if (VITEST_CONFIGS.some((f) => existsSync(join(root, f)))) return 'vitest';
  if (JEST_CONFIGS.some((f) => existsSync(join(root, f))) || hasJestField(root)) return 'jest';
  if (resolves(root, 'vitest/package.json') || resolves(root, 'vite-plus/package.json')) return 'vitest';
  if (resolves(root, 'jest/package.json')) return 'jest';
  if (PLAYWRIGHT_CONFIGS.some((f) => existsSync(join(root, f))) || resolves(root, '@playwright/test/package.json')) {
    throw new ConfigError("Playwright mutation testing is opt-in and can be slow. Set runner: 'playwright' in mutator.config.ts (or pass --runner playwright) to enable it.");
  }
  throw new ConfigError(`no automatic test runner found: neither vitest (or vite-plus) nor jest resolves from ${root}`);
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
  /** Playwright only: Chromium V8 coverage remapped to source scopes. */
  sourceCoverage?: boolean;
}

export async function createRunnerSession(runner: Runner, options: RunnerSessionOptions): Promise<Session> {
  const { root, targets, configFile, maxWorkers, sourceCoverage, pluginModules, hasPluginObjects, ...instrument } = options;
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
      ...(sourceCoverage !== undefined ? { sourceCoverage } : {}),
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
