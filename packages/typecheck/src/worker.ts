// Runs a type check in a worker thread: the checkers block their thread for the whole check.
import { parentPort, workerData } from 'node:worker_threads';
import { type TypeCheckerOptions, createTypeChecker } from './index.ts';
import type { TypecheckMutant } from './types.ts';

const { mutants, ...options } = workerData as TypeCheckerOptions & { mutants: TypecheckMutant[] };
const checker = await createTypeChecker(options);
if (!checker) {
  parentPort!.postMessage(undefined);
} else {
  try {
    // Equivalence first: it reads the original program, before any mutant is swapped in.
    const equivalent = checker.equivalent(mutants);
    const errors = checker.check(mutants);
    parentPort!.postMessage({ version: checker.version, errors, equivalent, inputs: checker.inputs });
  } finally {
    checker.close();
  }
}
