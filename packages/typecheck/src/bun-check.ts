// Run by `bun` (see bun.ts): type-checks mutants with Bun's own checker, which
// `Bun.build({ check: true })` exposes with in-memory file contents (`files`).
// Each mutated text, and each original text for the baseline, is checked as a virtual sibling
// of its file: in the same directory, its imports resolve the same; imported by nothing, it
// affects no other text. So one build checks many mutants. The imports of a file in an import
// cycle (type-only ones included) lead back to its original text, which would type its sibling
// wrongly: such a file's mutants are checked one by one at its own path instead.
// Reads `{ tsconfig, mutants }` as JSON on stdin; writes `[key, first new error][]` as JSON on stdout.
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { applyMutant } from '@mizchi/mutator-core';
import { inImportCycle, readProgram } from './bun-program.ts';
import { firstNewError } from './diff.ts';
import type { TypecheckMutant } from './types.ts';

// Only the part of Bun's API used here (the repository does not depend on bun-types).
declare const Bun: {
  build(options: Record<string, unknown>): Promise<{ logs: { level: string; message: string; position: { file: string } | null }[] }>;
};

type Entry = Readonly<{ path: string; text: string }>;
type Located = Readonly<{ mutant: TypecheckMutant; file: string }>;

/** Mutants per build: a build holds a copy of the file per mutant (about 0.5 MB each on a 300-line file). */
const CHUNK_SIZE = 200;

const { tsconfig, mutants } = JSON.parse(readFileSync(0, 'utf8')) as { tsconfig: string; mutants: TypecheckMutant[] };

/** A path next to `file` that no source imports: `a.ts` -> `a.mutator-3.ts`. */
const siblingPath = (file: string, n: number): string => join(dirname(file), `${basename(file, extname(file))}.mutator-${n}${extname(file)}`);

/** `[key, error]` when `found` has an error that `baseline` does not account for. */
const verdict = (key: string, baseline: readonly string[], found: readonly string[]): [string, string][] => {
  const error = firstNewError(baseline, found);
  return error === undefined ? [] : [[key, error]];
};

/**
 * Errors of each entry: type errors as `code message` like the TypeScript checkers report them,
 * other errors (syntax, resolution) as Bun's message (side effect: runs Bun's checker).
 */
const typeErrors = async (entries: readonly Entry[]): Promise<Map<string, string[]>> => {
  const { logs } = await Bun.build({
    entrypoints: entries.map((entry) => entry.path),
    files: Object.fromEntries(entries.map((entry) => [entry.path, entry.text])),
    tsconfig, check: true, throw: false, target: 'bun', packages: 'external',
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
  const rest = entries.filter((entry) => !unchecked.has(entry.path));
  if (unchecked.size === 0 || rest.length === 0) return errors;
  const checked = await typeErrors(rest);
  return new Map([...errors].map(([path, found]) => [path, checked.get(path) ?? found]));
};

const sources = new Map<string, string>();
const located: Located[] = mutants.map((mutant) => {
  const file = realpathSync(resolve(mutant.file));
  if (!sources.has(file)) sources.set(file, readFileSync(file, 'utf8'));
  return { mutant, file };
});

/** Mutants of files outside import cycles, checked as siblings in one build. */
const checkAsSiblings = async (chunk: readonly Located[]): Promise<[string, string][]> => {
  const files = [...new Set(chunk.map(({ file }) => file))];
  const originals = new Map(files.map((file, n) => [file, { path: siblingPath(file, n), text: sources.get(file)! }]));
  const mutated = chunk.map(({ mutant, file }, i) => ({ path: siblingPath(file, files.length + i), text: applyMutant(sources.get(file)!, mutant) }));
  const errors = await typeErrors([...originals.values(), ...mutated]);
  return chunk.flatMap(({ mutant, file }, i) => verdict(mutant.key, errors.get(originals.get(file)!.path)!, errors.get(mutated[i]!.path)!));
};

/** Mutants of a file in an import cycle, one build each at the file's own path. */
const checkInPlace = async (file: string, fileMutants: readonly TypecheckMutant[]): Promise<[string, string][]> => {
  const source = sources.get(file)!;
  const errorsAt = async (text: string) => (await typeErrors([{ path: file, text }])).get(file)!;
  const baseline = await errorsAt(source);
  const result: [string, string][] = [];
  for (const mutant of fileMutants) result.push(...verdict(mutant.key, baseline, await errorsAt(applyMutant(source, mutant))));
  return result;
};

const { imports } = readProgram(tsconfig);
const inCycle = new Set([...sources.keys()].filter((file) => inImportCycle(file, imports)));
const result: [string, string][] = [];
const outside = located.filter(({ file }) => !inCycle.has(file));
for (let i = 0; i < outside.length; i += CHUNK_SIZE) result.push(...await checkAsSiblings(outside.slice(i, i + CHUNK_SIZE)));
const inside = Map.groupBy(located.filter(({ file }) => inCycle.has(file)), ({ file }) => file);
for (const [file, group] of inside) result.push(...await checkInPlace(file, group.map(({ mutant }) => mutant)));
process.stdout.write(JSON.stringify(result));
