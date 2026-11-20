// Run by `bun` (see bun.ts) in the project root: what Bun's checker reads for a tsconfig, as JSON
// `{ files, directories }`. argv: the tsconfig, and the root as the caller writes it.
// The files are the program's (see bun-program.ts) and the tsconfig with every file it extends, so
// that editing an inherited configuration invalidates cached verdicts. The directories are all those
// below the tsconfig's, so that a file added anywhere the configuration may include does too.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readProgram } from './bun-program.ts';

// Only the part of Bun's API used here (the repository does not depend on bun-types).
declare const Bun: {
  JSONC: { parse(text: string): unknown };
  resolveSync(specifier: string, from: string): string;
};

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/** The JSON (with comments) in `file`; undefined when it cannot be read (side effect: reads it). */
const readJsonc = (file: string): unknown => {
  try {
    return Bun.JSONC.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/** Where Bun's resolver finds `specifier` from `from`; undefined when it does not. */
const resolveModule = (specifier: string, from: string): string | undefined => {
  try {
    return Bun.resolveSync(specifier, from);
  } catch {
    return undefined;
  }
};

/** The file at `path`, or at `path` with `.json` added; undefined when neither exists. */
const jsonFile = (path: string) => [path, `${path}.json`].find(isFile);

/** The file an `extends` entry names, found the ways TypeScript looks; undefined when none exists. */
const resolveExtends = (specifier: string, from: string): string | undefined => {
  // A path stays as written (Bun's resolver would follow symlinks).
  if (specifier.startsWith('.') || isAbsolute(specifier)) return jsonFile(resolve(from, specifier));
  // A package: the configuration its package.json names in `tsconfig`, its tsconfig.json, or a
  // JSON file inside it (never its `main`).
  const manifest = resolveModule(`${specifier}/package.json`, from);
  const named = manifest === undefined ? undefined : (readJsonc(manifest) as { tsconfig?: unknown } | undefined)?.tsconfig;
  const fromField = typeof named === 'string' ? jsonFile(resolve(dirname(manifest!), named)) : undefined;
  if (fromField !== undefined) return fromField;
  return [`${specifier}/tsconfig.json`, specifier].map((form) => resolveModule(form, from)).find((file) => file?.endsWith('.json'));
};

/** `config` and the files it extends, transitively (side effect: reads them). */
const configChain = (config: string, seen: Set<string> = new Set()): Set<string> => {
  seen.add(config);
  // A configuration Bun's checker cannot read is still an input; the checker reports it.
  const bases = (readJsonc(config) as { extends?: unknown } | undefined)?.extends;
  for (const specifier of [bases ?? []].flat()) {
    const base = typeof specifier === 'string' ? resolveExtends(specifier, dirname(config)) : undefined;
    if (base !== undefined && !seen.has(base)) configChain(base, seen);
  }
  return seen;
};

/** Not where sources live: dependencies and tool state. */
const SKIPPED = new Set(['node_modules', '.git', '.mutator']);

/** `dir` and every directory below it but the skipped ones (side effect: reads them). */
const directoriesUnder = (dir: string): string[] => [
  dir,
  ...readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !SKIPPED.has(entry.name)).flatMap((entry) => directoriesUnder(join(dir, entry.name))),
];

const [tsconfig, root] = process.argv.slice(2) as [string, string];
process.stdout.write(JSON.stringify({
  files: [...configChain(tsconfig), ...readProgram(tsconfig, root).files],
  directories: directoriesUnder(dirname(tsconfig)),
}));
