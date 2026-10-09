import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClassicChecker } from './classic.ts';
import { createNativeChecker } from './native.ts';
import type { TypeChecker } from './types.ts';

export type { CheckerOptions, TypeChecker, TypecheckMutant } from './types.ts';
export { createClassicChecker } from './classic.ts';
export { createNativeChecker } from './native.ts';

/**
 * A type checker backed by the project's own `typescript`: the compiler API for
 * TypeScript <= 6, the native API (`typescript/unstable/sync`) for >= 7.
 * Undefined when the project has no `typescript` or no tsconfig.
 */
export async function createTypeChecker(options: { root: string; tsconfig?: string }): Promise<TypeChecker | undefined> {
  const { root } = options;
  const tsconfig = options.tsconfig ?? join(root, 'tsconfig.json');
  if (!existsSync(tsconfig)) return undefined;
  const require = createRequire(join(root, 'package.json'));
  let manifest: string;
  try {
    manifest = require.resolve('typescript/package.json');
  } catch {
    return undefined;
  }
  const version: string = JSON.parse(readFileSync(manifest, 'utf8')).version;
  const load = (specifier: string) => import(pathToFileURL(require.resolve(specifier)).href);
  if (Number.parseInt(version, 10) >= 7) {
    return createNativeChecker(await load('typescript/unstable/sync'), { root, tsconfig }, version);
  }
  const ts = await load('typescript');
  return createClassicChecker(ts.default ?? ts, { root, tsconfig });
}
