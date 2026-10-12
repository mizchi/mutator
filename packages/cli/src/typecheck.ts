// Type checking of mutants with the project's TypeScript, before any of them runs.
import type { Mutant } from '@mizchi/mutator-core';
import { checkInWorker, createTypeChecker } from '@mizchi/mutator-typecheck';

export const TS_FILE = /\.(c|m)?tsx?$/;

/** Type checking of the mutants in `keys`, started on a worker thread while the dry run goes on. */
export interface EarlyTypecheck {
  keys: ReadonlySet<string>;
  result: Promise<{ version: string; errors: Map<string, string>; durationMs: number } | undefined>;
  cancel: () => void;
}

/** Type-check `mutants` on a worker thread; a failure there leaves them to `typecheckJobs`. */
export function startTypecheck(root: string, mutants: readonly Mutant[]): EarlyTypecheck | undefined {
  if (mutants.length === 0) return undefined;
  const started = performance.now();
  const abort = new AbortController();
  const result = checkInWorker({ root, signal: abort.signal }, mutants).then(
    (checked) => checked && { ...checked, durationMs: performance.now() - started },
    () => undefined,
  );
  return { keys: new Set(mutants.map((m) => m.key)), result, cancel: () => abort.abort() };
}

export async function typecheckJobs(root: string, setting: boolean | 'auto', mutants: readonly Mutant[], log: (message: string) => void, early?: EarlyTypecheck): Promise<Map<string, string>> {
  const all = mutants.filter((m) => TS_FILE.test(m.file));
  if (setting === false || all.length === 0) {
    early?.cancel();
    return new Map();
  }
  const pre = await early?.result;
  const errors = new Map<string, string>();
  if (pre) {
    for (const m of all) {
      const error = pre.errors.get(m.key);
      if (error !== undefined) errors.set(m.key, error);
    }
    log(`typecheck (TypeScript ${pre.version}): ${early!.keys.size} mutants in ${(pre.durationMs / 1000).toFixed(1)}s, alongside the dry run`);
  }
  const candidates = pre ? all.filter((m) => !early!.keys.has(m.key)) : all;
  if (candidates.length === 0) return errors;
  const checker = await createTypeChecker({ root });
  if (!checker) {
    if (setting === true) throw new Error('typecheck: no typescript package or tsconfig.json found in the project');
    return new Map();
  }
  try {
    const started = performance.now();
    const result = checker.check(candidates);
    log(`typecheck (TypeScript ${checker.version}): ${candidates.length} mutants in ${((performance.now() - started) / 1000).toFixed(1)}s`);
    return new Map([...errors, ...result]);
  } finally {
    checker.close();
  }
}
