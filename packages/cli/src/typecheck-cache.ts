// A type verdict is reusable only while every compiler input and resolution directory agrees.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { type Mutant, hash } from '@mizchi/mutator-core';
import type { TypecheckInputs } from '@mizchi/mutator-typecheck';

interface DirectoryReader {
  sys: { readDirectory(directory: string, extensions?: readonly string[], excludes?: readonly string[], includes?: readonly string[], depth?: number): string[] };
}

export interface TypecheckCache {
  inputs: TypecheckInputs;
  fingerprint: string;
  results: Record<string, { source: string; error?: string; equivalent?: `equivalent: ${string}` }>;
}

function content(file: string): string {
  try {
    return readFileSync(file).toString('base64');
  } catch {
    return '<missing>';
  }
}

const internal = (file: string) => file.split(/[\\/]/).some((part) => part === '.mutator' || part === '.git');

export function typeInputHash(root: string, inputs: TypecheckInputs): string | undefined {
  const files = inputs.files.flatMap((file) => [file, content(join(root, file))]);
  const directories = inputs.directories.filter((file) => !internal(file)).map((file) => {
    try {
      const entries = readdirSync(join(root, file), { withFileTypes: true })
        .filter((entry) => !internal(entry.name))
        .map((entry) => [entry.name, entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'])
        .sort(([a], [b]) => a!.localeCompare(b!));
      return [file, entries];
    } catch {
      return [file, '<missing>'];
    }
  });
  const searches: string[][] = [];
  if (inputs.searches.length) {
    try {
      // Loading TS <= 6's directory matcher does not start a compiler or language service.
      const ts = createRequire(join(root, 'package.json'))('typescript') as DirectoryReader;
      for (const search of inputs.searches) {
        const found = ts.sys.readDirectory(join(root, search.directory), search.extensions, search.excludes, search.includes, search.depth);
        searches.push([JSON.stringify(search), ...found.map((file) => relative(root, file)).sort()]);
      }
    } catch { return undefined; }
  }
  return hash(JSON.stringify([files, directories, searches]));
}

export function portableTypeInputs(root: string, inputs: readonly TypecheckInputs[]): TypecheckInputs {
  const collect = (key: 'files' | 'directories') => [...new Set(inputs.flatMap((input) => input[key].map((file) => relative(root, file))))].sort();
  const searches = new Map(inputs.flatMap((input) => input.searches.map((search) => {
    const portable = { ...search, directory: relative(root, search.directory) };
    return [JSON.stringify(portable), portable] as const;
  })));
  return { files: collect('files'), directories: collect('directories'), searches: [...searches.values()] };
}

export function cachedTypechecks(root: string, previous: TypecheckCache | undefined, mutants: readonly Mutant[]) {
  const valid = previous !== undefined && previous.fingerprint === typeInputHash(root, previous.inputs);
  const hits = new Map<string, TypecheckCache['results'][string]>();
  if (valid) {
    const sources = new Map<string, string>();
    for (const mutant of mutants) {
      const source = sources.get(mutant.file) ?? hash(content(mutant.file));
      sources.set(mutant.file, source);
      const result = previous.results[mutant.key];
      if (result?.source === source) hits.set(mutant.key, result);
    }
  }
  return { valid, hits, missing: mutants.filter((mutant) => !hits.has(mutant.key)) };
}

export function storeTypechecks(root: string, inputs: readonly TypecheckInputs[], mutants: readonly Mutant[], errors: ReadonlyMap<string, string>, equivalent: ReadonlyMap<string, `equivalent: ${string}`>, previous?: TypecheckCache): TypecheckCache | undefined {
  const portable = portableTypeInputs(root, inputs);
  const results = { ...previous?.results };
  const sources = new Map<string, string>();
  for (const mutant of mutants) {
    const source = sources.get(mutant.file) ?? hash(content(mutant.file));
    sources.set(mutant.file, source);
    const error = errors.get(mutant.key);
    const reason = equivalent.get(mutant.key);
    results[mutant.key] = { source, ...(error !== undefined ? { error } : {}), ...(reason !== undefined ? { equivalent: reason } : {}) };
  }
  const fingerprint = typeInputHash(root, portable);
  return fingerprint === undefined ? undefined : { inputs: portable, fingerprint, results };
}
