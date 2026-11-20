// Run by `bun` (see bun.ts) in the project root: what Bun's checker reads for a tsconfig, as JSON
// `{ files, directories }`. argv: the tsconfig, and the root as the caller writes it.
// The files are the program's (see bun-program.ts), the tsconfig with every file it extends, and the
// package manifests consulted to find those, so that editing an inherited configuration invalidates
// cached verdicts. The directories are all those below where the `include` patterns can match, so
// that a file added anywhere the configuration may include does too.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readProgram } from './bun-program.ts';

// Only the part of Bun's API used here (the repository does not depend on bun-types).
declare const Bun: {
  JSONC: { parse(text: string): unknown };
  resolveSync(specifier: string, from: string): string;
};

type Config = Readonly<{ extends?: unknown; include?: unknown; files?: unknown }>;
type Chain = { configs: Map<string, Config>; manifests: Set<string> };

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

/**
 * The file an `extends` entry names, found the ways TypeScript looks (undefined when none exists),
 * and the package manifest consulted on the way, if any.
 */
const resolveExtends = (specifier: string, from: string): { file: string | undefined; manifest?: string } => {
  // A path stays as written (Bun's resolver would follow symlinks).
  if (specifier.startsWith('.') || isAbsolute(specifier)) return { file: jsonFile(resolve(from, specifier)) };
  // A package: the configuration its package.json names in `tsconfig`, its tsconfig.json, or a
  // JSON file inside it (never its `main`).
  const manifest = resolveModule(`${specifier}/package.json`, from);
  const named = manifest === undefined ? undefined : (readJsonc(manifest) as { tsconfig?: unknown } | undefined)?.tsconfig;
  const file = (typeof named === 'string' ? jsonFile(resolve(dirname(manifest!), named)) : undefined)
    ?? [`${specifier}/tsconfig.json`, specifier].map((form) => resolveModule(form, from)).find((found) => found?.endsWith('.json'));
  return manifest === undefined ? { file } : { file, manifest };
};

/** `config` and the files it extends, transitively, with their contents (side effect: reads them). */
const readChain = (config: string, chain: Chain = { configs: new Map(), manifests: new Set() }): Chain => {
  // A configuration Bun's checker cannot read is still an input; the checker reports it.
  const json = (readJsonc(config) ?? {}) as Config;
  chain.configs.set(config, json);
  for (const specifier of [json.extends ?? []].flat()) {
    if (typeof specifier !== 'string') continue;
    const { file, manifest } = resolveExtends(specifier, dirname(config));
    if (manifest !== undefined) chain.manifests.add(manifest);
    if (file !== undefined && !chain.configs.has(file)) readChain(file, chain);
  }
  return chain;
};

/** A path naming a file TypeScript reads, rather than a directory to include. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json)$/;

/**
 * The directories below which the chain's `include` patterns can match: each pattern's part before
 * its first wildcard, from the configuration that declares it, or the directory of a file it names.
 * Without `include` or `files`, the default pattern matches below the tsconfig's directory.
 */
const includeRoots = (tsconfig: string, configs: ReadonlyMap<string, Config>): string[] => {
  if (![...configs.values()].some((config) => config.include !== undefined || config.files !== undefined)) return [dirname(tsconfig)];
  return [...configs].flatMap(([file, config]) => (Array.isArray(config.include) ? config.include : []).flatMap((pattern: unknown) => {
    if (typeof pattern !== 'string') return [];
    const parts = pattern.split(/[\\/]/);
    const wildcard = parts.findIndex((part) => /[*?[{]/.test(part));
    // Joined back as written, so that an absolute pattern keeps its root.
    const base = resolve(dirname(file), wildcard < 0 ? pattern : parts.slice(0, wildcard).join('/'));
    // A file, present or not yet, appears in its directory.
    return [wildcard < 0 && (SOURCE_FILE.test(base) || isFile(base)) ? dirname(base) : base];
  }));
};

/** Not where sources live: dependencies and tool state. */
const SKIPPED = new Set(['node_modules', '.git', '.mutator']);

/** `dir` and every directory below it but the skipped ones (side effect: reads them). */
const directoriesUnder = (dir: string): string[] => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Missing or unreadable: recorded all the same, so that a change to it invalidates the cache.
    return [dir];
  }
  return [dir, ...entries.filter((entry) => entry.isDirectory() && !SKIPPED.has(entry.name)).flatMap((entry) => directoriesUnder(join(dir, entry.name)))];
};

const [tsconfig, root] = process.argv.slice(2) as [string, string];
const { configs, manifests } = readChain(tsconfig);
process.stdout.write(JSON.stringify({
  files: [...configs.keys(), ...manifests, ...readProgram(tsconfig, root).files],
  directories: [...new Set(includeRoots(tsconfig, configs).flatMap(directoriesUnder))],
}));
