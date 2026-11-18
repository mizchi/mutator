import { createRequire, findPackageJSON } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface TestRuntime {
  /** Absolute Node API entry point, imported by the session. */
  node: string;
  /** Worker API specifier, resolved by Vite with ESM import conditions. */
  setup: 'vite-plus/test' | 'vitest';
}

/** Match vp test's precedence and use the target project's runner, not the adapter's peer. */
export function resolveTestRuntime(root: string): TestRuntime {
  const parent = pathToFileURL(resolve(root, 'package.json'));
  for (const setup of ['vite-plus/test', 'vitest'] as const) {
    try {
      // ESM package lookup ignores NODE_PATH, which pnpm's bin shims populate with hoisted packages.
      const manifest = findPackageJSON(setup === 'vite-plus/test' ? 'vite-plus' : 'vitest', parent);
      if (manifest) return { node: realpathSync.native(createRequire(manifest).resolve(`${setup}/node`)), setup };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND' && code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    }
  }
  throw new Error(`mutator: neither vite-plus/test/node nor vitest/node resolves from ${root}`);
}
