// Type checking of mutants with the project's TypeScript, before any of them runs.
import { join } from 'node:path';
import type { Mutant } from '@mizchi/mutator-core';
import { type TypeChecker, type TypecheckInputs, checkInWorker, createTypeChecker } from '@mizchi/mutator-typecheck';
import { type TypecheckCache, cachedTypechecks, storeTypechecks } from './typecheck-cache.ts';

export const TS_FILE = /\.(c|m)?tsx?$/;

/** Mutant key -> first new type error, and mutant key -> `equivalent: ...` (proven by types). */
export interface TypecheckResult {
  errors: Map<string, string>;
  equivalent: Map<string, `equivalent: ${string}`>;
  cache?: TypecheckCache;
  /** Mutants left unchecked because the deadline passed: they are neither run nor cached. */
  unchecked: Set<string>;
}

/** Type checking of the mutants in `keys`, started on a worker thread while the dry run goes on. */
export interface EarlyTypecheck {
  keys: ReadonlySet<string>;
  result: Promise<({ version: string; durationMs: number; inputs: TypecheckInputs } & Omit<TypecheckResult, 'unchecked'>) | undefined>;
  cancel: () => void;
}

const EMPTY = (): TypecheckResult => ({ errors: new Map(), equivalent: new Map(), unchecked: new Set() });

/**
 * Mutants per `check` call under a time budget; the deadline is looked at between calls, so it is overrun
 * by one batch at most. Without a budget all go in one call, which saves Bun's checker a build per batch.
 */
const BATCH_SIZE = 50;

export interface TypecheckOptions {
  early?: EarlyTypecheck | undefined;
  cache?: TypecheckCache | undefined;
  /** `performance.now()` after which no further batch is checked (the run's time budget). */
  deadline?: number | undefined;
  /** The project runs on Bun, so Bun's checker may find the type errors (see createTypeChecker). */
  preferBun?: boolean | undefined;
  /** Test seams. */
  now?: () => number;
  batchSize?: number;
  createChecker?: (root: string) => Promise<TypeChecker | undefined>;
}

/** Type-check `mutants` on a worker thread; a failure there leaves them to `typecheckJobs`. */
export function startTypecheck(root: string, mutants: readonly Mutant[], { cache, preferBun }: Pick<TypecheckOptions, 'cache' | 'preferBun'> = {}): EarlyTypecheck | undefined {
  mutants = cachedTypechecks(root, cache, mutants).missing;
  if (mutants.length === 0) return undefined;
  const started = performance.now();
  const abort = new AbortController();
  const result = checkInWorker({ root, preferBun, signal: abort.signal }, mutants).then(
    (checked) => checked && { ...checked, equivalent: checked.equivalent as TypecheckResult['equivalent'], durationMs: performance.now() - started },
    () => undefined,
  );
  return { keys: new Set(mutants.map((m) => m.key)), result, cancel: () => abort.abort() };
}

export async function typecheckJobs(root: string, setting: boolean | 'auto', mutants: readonly Mutant[], log: (message: string) => void, options: TypecheckOptions = {}): Promise<TypecheckResult> {
  const { early, cache, deadline = Infinity, now = () => performance.now() } = options;
  const batchSize = options.batchSize ?? (deadline === Infinity ? Infinity : BATCH_SIZE);
  let all = mutants.filter((m) => TS_FILE.test(m.file));
  if (setting === false || all.length === 0) {
    early?.cancel();
    return EMPTY();
  }
  const pre = await untilDeadline(early, deadline, now);
  const { errors, equivalent, unchecked } = EMPTY();
  const cached = cachedTypechecks(root, cache, all);
  const inputs: TypecheckInputs[] = cached.valid && cache ? [{
    files: cache.inputs.files.map((f) => join(root, f)),
    directories: cache.inputs.directories.map((f) => join(root, f)),
    directoryChecks: cache.inputs.directoryChecks.map((f) => join(root, f)),
    searches: cache.inputs.searches.map((search) => ({ ...search, directory: join(root, search.directory) })),
  }] : [];
  for (const [key, result] of cached.hits) {
    if (result.error !== undefined) errors.set(key, result.error);
    if (result.equivalent !== undefined) equivalent.set(key, result.equivalent);
  }
  if (pre) {
    inputs.push(pre.inputs);
    for (const m of all) {
      const error = pre.errors.get(m.key);
      if (error !== undefined) errors.set(m.key, error);
      const reason = pre.equivalent.get(m.key);
      if (reason !== undefined) equivalent.set(m.key, reason);
    }
    log(`typecheck (TypeScript ${pre.version}): ${early!.keys.size} mutants in ${(pre.durationMs / 1000).toFixed(1)}s, alongside the dry run`);
  }
  const candidates = cached.missing.filter((m) => !pre || !early!.keys.has(m.key));
  let listed = true;
  const finish = (): TypecheckResult => {
    // Only what was checked is cached: an unchecked mutant has no verdict yet.
    if (unchecked.size) all = all.filter((m) => !unchecked.has(m.key));
    // Without the checker's inputs, a later change to them would go unnoticed: nothing is cached.
    const next = listed ? storeTypechecks(root, inputs, all, errors, equivalent, cached.valid ? cache : undefined) : undefined;
    return { errors, equivalent, unchecked, ...(next ? { cache: next } : {}) };
  };
  if (candidates.length === 0) return finish();
  const checker = await (options.createChecker ?? ((r) => createTypeChecker({ root: r, preferBun: options.preferBun })))(root);
  if (!checker) {
    const missing = 'needs a tsconfig.json and either the typescript package or Bun 1.4+ (bun check)';
    if (setting === true) throw new Error(`typecheck: ${missing}`);
    log(`typecheck skipped: ${missing}; mutants that do not compile run as tests instead`);
    return EMPTY();
  }
  try {
    const started = now();
    let checked = 0;
    // In batches, so the time budget can stop type checking: the rest stay unchecked (Pending).
    while (checked < candidates.length && now() < deadline) {
      const batch = candidates.slice(checked, checked + batchSize);
      // Equivalence first: it reads the original program, before any mutant is swapped in.
      // `check` restores every file it swaps, so each batch starts from the original program.
      const proven = checker.equivalent(batch) as TypecheckResult['equivalent'];
      for (const [key, value] of checker.check(batch)) errors.set(key, value);
      for (const [key, value] of proven) equivalent.set(key, value);
      checked += batch.length;
    }
    for (const m of candidates.slice(checked)) unchecked.add(m.key);
    if (checked > 0) {
      log(`typecheck (TypeScript ${checker.version}): ${checked} mutants in ${((now() - started) / 1000).toFixed(1)}s`);
      try {
        inputs.push(checker.inputs);
      } catch (error) {
        listed = false;
        log(`typecheck inputs not listed, so the verdicts are not cached: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (unchecked.size) log(`time budget exhausted during type checking: ${unchecked.size} mutants not type-checked`);
    return finish();
  } finally {
    checker.close();
  }
}

/** The early type check's result, or undefined (and the check cancelled) if the deadline comes first. */
async function untilDeadline(early: EarlyTypecheck | undefined, deadline: number, now: () => number) {
  if (!early) return undefined;
  if (deadline === Infinity) return early.result;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - now()), undefined); });
  try {
    const result = await Promise.race([early.result, expired]);
    if (result === undefined) early.cancel();
    return result;
  } finally {
    clearTimeout(timer);
  }
}
