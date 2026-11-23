import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { bunTypescriptVersion, createBunChecker, withBunErrors } from './bun.ts';
import { createClassicChecker } from './classic.ts';
import { createNativeChecker } from './native.ts';
import type { TypeChecker, TypecheckMutant } from './types.ts';

export type { CheckerOptions, TypeChecker, TypecheckMutant, TypecheckInputs, TypecheckSearch } from './types.ts';

export type TypeCheckerOptions = {
  root: string;
  tsconfig?: string;
  /** The project runs on Bun: Bun's checker may find the type errors (see createTypeChecker). */
  preferBun?: boolean | undefined;
};

/**
 * A type checker backed by the project's own `typescript`: the compiler API for
 * TypeScript <= 6, the native API (`typescript/unstable/sync`) for >= 7.
 * Without `typescript`, Bun's own checker (`bun check`, Bun 1.4+) when `bun` is available.
 * With `preferBun`, Bun's checker also finds the type errors when it bundles the project's
 * TypeScript major: it checks a batch of mutants per build, far faster, with the same verdicts;
 * equivalences still come from the project's TypeScript.
 * Undefined when the project has no tsconfig, or neither of those.
 */
export async function createTypeChecker(options: TypeCheckerOptions): Promise<TypeChecker | undefined> {
  const { root } = options;
  const tsconfig = options.tsconfig ?? join(root, 'tsconfig.json');
  if (!existsSync(tsconfig)) return undefined;
  const require = createRequire(join(root, 'package.json'));
  let manifest: string;
  try {
    manifest = require.resolve('typescript/package.json');
  } catch {
    const bunVersion = bunTypescriptVersion(root);
    return bunVersion === undefined ? undefined : createBunChecker({ root, tsconfig }, bunVersion);
  }
  const version: string = JSON.parse(readFileSync(manifest, 'utf8')).version;
  const load = (specifier: string) => import(pathToFileURL(require.resolve(specifier)).href);
  const major = Number.parseInt(version, 10);
  let checker: TypeChecker;
  if (major >= 7) {
    checker = createNativeChecker(await load('typescript/unstable/sync'), { root, tsconfig }, version);
    const bunVersion = options.preferBun ? bunTypescriptVersion(root) : undefined;
    if (bunVersion?.startsWith(`${major}.`)) {
      checker = withBunErrors(checker, createBunChecker({ root, tsconfig }, bunVersion));
    }
  } else {
    const ts = await load('typescript');
    checker = createClassicChecker(ts.default ?? ts, { root, tsconfig });
  }
  return {
    version: checker.version,
    get inputs() { const inputs = checker.inputs; return { ...inputs, files: [...inputs.files, manifest] }; },
    check: (mutants) => checker.check(mutants),
    equivalent: (mutants) => checker.equivalent(mutants),
    close: () => checker.close(),
  };
}

// Published builds ship worker.js next to index.js.
const WORKER_FILE = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url));

/** Verdicts of one batch of `checkInWorker`, in the order the mutants were given. */
export interface TypecheckBatch {
  keys: string[];
  errors: Map<string, string>;
  equivalent: Map<string, string>;
}

/**
 * `createTypeChecker(options).check(mutants)` (and `.equivalent(mutants)`) in a child process, leaving this thread free
 * (e.g. to drive a test run meanwhile). Undefined when there is nothing to check with.
 * With `batchSize`, mutants are checked in batches of that size, in order, and `onBatch` gets each batch's verdicts
 * as soon as they are known.
 */
export function checkInWorker(
  options: TypeCheckerOptions & { signal?: AbortSignal; batchSize?: number },
  mutants: readonly TypecheckMutant[],
  { onBatch }: { onBatch?: (batch: TypecheckBatch) => void } = {},
): Promise<{ version: string; errors: Map<string, string>; equivalent: Map<string, string>; inputs: import('./types.ts').TypecheckInputs } | undefined> {
  const { signal, ...data } = options;
  return new Promise((resolve, reject) => {
    // `execArgv: []`: the parent may run under a test runner's loader flags, which the checker does not need.
    const child = fork(WORKER_FILE, [], { serialization: 'advanced', execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    // Aborted: the result is not needed; stop the child so it does not hold the process.
    signal?.addEventListener('abort', () => { child.kill(); finish(() => resolve(undefined)); }, { once: true });
    child.on('message', (message: { batch?: TypecheckBatch; result?: unknown }) => {
      if (message.batch) onBatch?.(message.batch);
      else finish(() => resolve(message.result as never));
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, sig) => finish(() => (code === 0 ? resolve(undefined) : reject(new Error(`typecheck process exited with ${sig ?? `code ${code}`}${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`)))));
    child.send({ ...data, mutants });
  });
}
