import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createClassicChecker } from './classic.ts';
import { createNativeChecker } from './native.ts';
import type { TypeChecker, TypecheckMutant } from './types.ts';

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

// Published builds ship worker.js next to index.js.
const WORKER_FILE = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url));

/**
 * `createTypeChecker(options).check(mutants)` on a worker thread, leaving this thread free
 * (e.g. to drive a test run meanwhile). Undefined when there is nothing to check with.
 */
export function checkInWorker(
  options: { root: string; tsconfig?: string; signal?: AbortSignal },
  mutants: readonly TypecheckMutant[],
): Promise<{ version: string; errors: Map<string, string> } | undefined> {
  const { signal, ...data } = options;
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_FILE, { workerData: { ...data, mutants } });
    // Aborted: the result is not needed; stop the worker so it does not hold the process.
    signal?.addEventListener('abort', () => void worker.terminate().then(() => resolve(undefined)), { once: true });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`typecheck worker exited with code ${code}`))));
  });
}
