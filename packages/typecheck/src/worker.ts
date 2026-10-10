// Runs a type check in a worker thread: the checkers block their thread for the whole check.
import { parentPort, workerData } from 'node:worker_threads';
import { createTypeChecker } from './index.ts';
import type { TypecheckMutant } from './types.ts';

const { root, tsconfig, mutants } = workerData as { root: string; tsconfig?: string; mutants: TypecheckMutant[] };
const checker = await createTypeChecker({ root, ...(tsconfig ? { tsconfig } : {}) });
if (!checker) {
  parentPort!.postMessage(undefined);
} else {
  try {
    parentPort!.postMessage({ version: checker.version, errors: checker.check(mutants) });
  } finally {
    checker.close();
  }
}
