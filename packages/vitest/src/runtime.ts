import { createRequire, findPackageJSON } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface TestRuntime {
  /** Absolute Node API entry point, imported by the session. */
  node: string;
  /** Worker API specifier, resolved by Vite with ESM import conditions. */
  setup: 'vite-plus/test' | 'vitest';
  /** The `package.json` the runtime was resolved from; the setup specifier is resolved from it too. */
  importer: string;
}

/**
 * Match vp test's precedence and use the target project's runner, not the adapter's peer.
 * A project may keep its runner next to the Vitest config file, outside the root (an isolated
 * toolchain); that directory is tried only when the root resolves neither runner.
 */
export function resolveTestRuntime(root: string, configFile?: string): TestRuntime {
  const bases = [resolve(root)];
  const configDir = configFile && dirname(resolve(root, configFile));
  if (configDir && configDir !== bases[0]) bases.push(configDir);
  for (const base of bases) {
    const runtime = resolveFrom(base);
    if (runtime) return runtime;
  }
  throw new Error(`mutator: neither vite-plus/test/node nor vitest/node resolves from ${bases.join(' or ')}`);
}

function resolveFrom(base: string): TestRuntime | undefined {
  const importer = resolve(base, 'package.json');
  const parent = pathToFileURL(importer);
  for (const setup of ['vite-plus/test', 'vitest'] as const) {
    try {
      // ESM package lookup ignores NODE_PATH, which pnpm's bin shims populate with hoisted packages.
      const manifest = findPackageJSON(setup === 'vite-plus/test' ? 'vite-plus' : 'vitest', parent);
      if (manifest) return { node: realpathSync.native(createRequire(manifest).resolve(`${setup}/node`)), setup, importer };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND' && code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    }
  }
  return undefined;
}
