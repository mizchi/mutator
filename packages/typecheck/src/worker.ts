// Runs a type check in a worker thread: the checkers block their thread for the whole check.
// With `batchSize`, each batch's verdicts are posted as soon as they are known (`{ batch }`),
// then the whole result; without it, only the whole result.
import { parentPort, workerData } from 'node:worker_threads';
import { type TypeCheckerOptions, createTypeChecker } from './index.ts';
import type { TypecheckMutant } from './types.ts';

const { mutants, batchSize, ...options } = workerData as TypeCheckerOptions & { mutants: TypecheckMutant[]; batchSize?: number };
const checker = await createTypeChecker(options);
if (!checker) {
  parentPort!.postMessage(undefined);
} else {
  try {
    const errors = new Map<string, string>();
    const equivalent = new Map<string, string>();
    const size = batchSize ?? Math.max(1, mutants.length);
    for (let at = 0; at < mutants.length; at += size) {
      const batch = mutants.slice(at, at + size);
      // Equivalence first: it reads the original program, before any mutant is swapped in.
      // `check` restores every file it swaps, so each batch starts from the original program.
      const proven = checker.equivalent(batch);
      const failed = checker.check(batch);
      for (const [key, value] of failed) errors.set(key, value);
      for (const [key, value] of proven) equivalent.set(key, value);
      if (batchSize !== undefined) parentPort!.postMessage({ batch: { keys: batch.map((m) => m.key), errors: failed, equivalent: proven } });
    }
    parentPort!.postMessage({ version: checker.version, errors, equivalent, inputs: checker.inputs });
  } finally {
    checker.close();
  }
}
