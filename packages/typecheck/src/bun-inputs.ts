// Run by `bun` (see bun.ts) in the project root: the files Bun's checker reads for a tsconfig, as a JSON array.
// argv: the tsconfig, and the root as the caller writes it.
// They are the program's files (see bun-program.ts) and the tsconfig with every file it extends,
// so that editing an inherited configuration invalidates cached verdicts.
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readProgram } from './bun-program.ts';

// Only the part of Bun's API used here (the repository does not depend on bun-types).
declare const Bun: {
  JSONC: { parse(text: string): unknown };
  resolveSync(specifier: string, from: string): string;
};

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/** The file an `extends` entry names, found the ways TypeScript looks; undefined when none exists. */
const resolveExtends = (specifier: string, from: string): string | undefined => {
  // A path stays as written (Bun's resolver would follow symlinks).
  if (specifier.startsWith('.') || isAbsolute(specifier)) return [specifier, `${specifier}.json`].map((form) => resolve(from, form)).find(isFile);
  // A package: its tsconfig.json, or a JSON file inside it (never its `main`).
  for (const form of [`${specifier}/tsconfig.json`, specifier]) {
    try {
      const file = Bun.resolveSync(form, from);
      if (file.endsWith('.json')) return file;
    } catch {
      // Try the next form.
    }
  }
  return undefined;
};

/** `config` and the files it extends, transitively (side effect: reads them). */
const configChain = (config: string, seen: Set<string> = new Set()): Set<string> => {
  seen.add(config);
  let bases: unknown;
  try {
    bases = (Bun.JSONC.parse(readFileSync(config, 'utf8')) as { extends?: unknown }).extends;
  } catch {
    // Bun's checker reports a configuration it cannot read; it is an input all the same.
    return seen;
  }
  for (const specifier of [bases ?? []].flat()) {
    const base = typeof specifier === 'string' ? resolveExtends(specifier, dirname(config)) : undefined;
    if (base !== undefined && !seen.has(base)) configChain(base, seen);
  }
  return seen;
};

const [tsconfig, root] = process.argv.slice(2) as [string, string];
process.stdout.write(JSON.stringify([...configChain(tsconfig), ...readProgram(tsconfig, root).files]));
