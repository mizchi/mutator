// Run by `bun` (see bun.ts): type-checks mutants with Bun's own checker, which
// `Bun.build({ check: true })` exposes with in-memory file contents (`files`).
// Each mutated text, and each original text for the baseline, is checked as a virtual
// sibling of its file: in the same directory, its imports resolve the same; imported by
// nothing, it affects no other text. So one build checks every mutant of the call.
// Reads `{ mutants }` as JSON on stdin; writes `[key, first new error][]` as JSON on stdout.
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { applyMutant } from '@mizchi/mutator-core';
import { firstNewError } from './diff.ts';
import type { TypecheckMutant } from './types.ts';

// Only the part of Bun's API used here (the repository does not depend on bun-types).
declare const Bun: {
  build(options: Record<string, unknown>): Promise<{ logs: { level: string; message: string; position: { file: string } | null }[] }>;
};

type Entry = Readonly<{ path: string; text: string }>;

/** A path next to `file` that no source imports: `a.ts` -> `a.mutator-3.ts`. */
const siblingPath = (file: string, n: number): string => join(dirname(file), `${basename(file, extname(file))}.mutator-${n}${extname(file)}`);

/**
 * Errors of each entry: type errors as `code message` like the TypeScript checkers report them,
 * other errors (syntax, resolution) as Bun's message (side effect: runs Bun's checker).
 */
const typeErrors = async (entries: readonly Entry[]): Promise<Map<string, string[]>> => {
  const { logs } = await Bun.build({
    entrypoints: entries.map((entry) => entry.path),
    files: Object.fromEntries(entries.map((entry) => [entry.path, entry.text])),
    check: true, throw: false, target: 'bun', packages: 'external',
  });
  const errors = new Map(entries.map((entry) => [entry.path, [] as string[]]));
  const unchecked = new Set<string>();
  for (const log of logs) {
    const errorsOfEntry = log.level === 'error' && log.position ? errors.get(log.position.file) : undefined;
    if (!errorsOfEntry) continue;
    const match = /^TS(\d+): ([\s\S]*)$/.exec(log.message);
    errorsOfEntry.push(match ? `${match[1]} ${match[2]}` : log.message);
    if (!match) unchecked.add(log.position!.file);
  }
  // An error before type checking (e.g. a mutant Bun cannot parse) stops it for the whole build:
  // check the other entries again without those.
  if (unchecked.size === 0) return errors;
  const rest = await typeErrors(entries.filter((entry) => !unchecked.has(entry.path)));
  return new Map([...errors].map(([path, found]) => [path, unchecked.has(path) ? found : rest.get(path)!]));
};

const { mutants } = JSON.parse(readFileSync(0, 'utf8')) as { mutants: TypecheckMutant[] };
const originals = new Map<string, Entry>();
// Originals take sibling numbers below `mutants.length`, mutants the ones from there.
const mutated = mutants.map((mutant, i) => {
  const file = resolve(mutant.file);
  let original = originals.get(file);
  if (!original) {
    original = { path: siblingPath(file, originals.size), text: readFileSync(file, 'utf8') };
    originals.set(file, original);
  }
  return { key: mutant.key, baseline: original.path, path: siblingPath(file, mutants.length + i), text: applyMutant(original.text, mutant) };
});
const errors = await typeErrors([...originals.values(), ...mutated]);
const result = mutated.flatMap(({ key, baseline, path }) => {
  const error = firstNewError(errors.get(baseline)!, errors.get(path)!);
  return error === undefined ? [] : [[key, error] as const];
});
process.stdout.write(JSON.stringify(result));
