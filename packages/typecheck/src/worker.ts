// Runs a type check in a child process (forked with `serialization: 'advanced'`, so Maps
// survive IPC): the checkers block their thread for the whole check. A child process rather
// than a worker thread: a second isolate in the runner's process has crashed V8 while it freed
// WebAssembly code (`Check failed: end > addr`, Node 24) under load.
// It receives its input as the first message. With `batchSize`, each batch's verdicts are sent
// as soon as they are known (`{ batch }`), then the whole result; without it, only the whole result.
import { type TypeCheckerOptions, createTypeChecker } from './index.ts';
import type { TypecheckMutant } from './types.ts';

type Input = TypeCheckerOptions & { mutants: TypecheckMutant[]; batchSize?: number };
const send = (message: unknown) => new Promise<void>((resolve, reject) => process.send!(message, undefined, undefined, (error) => (error ? reject(error) : resolve())));
const input = await new Promise<Input>((resolve) => process.once('message', (message) => resolve(message as Input)));
const { mutants, batchSize, ...options } = input;
const checker = await createTypeChecker(options);
if (!checker) {
  await send({ result: undefined });
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
      if (batchSize !== undefined) await send({ batch: { keys: batch.map((m) => m.key), errors: failed, equivalent: proven } });
    }
    await send({ result: { version: checker.version, errors, equivalent, inputs: checker.inputs } });
  } finally {
    checker.close();
  }
}
process.disconnect?.();
