// Without the project's `typescript`: Bun's own type checker (`bun check`, TypeScript 7),
// run in a `bun` child process (bun-check.ts) because only Bun can call it.
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckerOptions, TypeChecker, TypecheckInputs } from './types.ts';

// Published builds ship the .js scripts next to bun.js.
const script = (name: string) => fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? `./${name}.ts` : `./${name}.js`, import.meta.url));
const CHECK_SCRIPT = script('bun-check');
const INPUTS_SCRIPT = script('bun-inputs');
const BUN = process.versions.bun ? process.execPath : 'bun';

/** Runs `bun` in `root` (side effect: a child process). */
const bun = (root: string, args: readonly string[], input = '') => spawnSync(BUN, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, input });

/** The TypeScript version Bun type-checks with; undefined without `bun` or without its checker (before Bun 1.4). */
export const bunTypescriptVersion = (root: string): string | undefined => {
  const { status, stdout } = bun(root, ['-p', 'process.versions.typescript']);
  if (status !== 0) return undefined;
  const version = stdout.trim();
  return /^\d+\.\d+/.test(version) ? version : undefined;
};

/** What bun-inputs.ts lists, with the project directories of the files: an added or removed source file invalidates cached verdicts. */
const programInputs = (root: string, { files, directories }: Readonly<{ files: readonly string[]; directories: readonly string[] }>): TypecheckInputs => {
  const inProject = (file: string) => {
    const path = relative(root, file);
    return !path.startsWith('..') && !isAbsolute(path) && !path.split(sep).includes('node_modules');
  };
  return { files: [...files], directories: [...new Set([...directories, ...files.filter(inProject).map(dirname)])], directoryChecks: [], searches: [] };
};

/** Runs a script of this package with Bun and parses its JSON output (side effect: a child process). */
const runScript = <T>(root: string, args: readonly string[], input?: string): T => {
  const { status, stdout, stderr, error } = bun(root, args, input);
  if (status !== 0) throw new Error(`bun ${basename(args[0] ?? '')} failed: ${error?.message ?? stderr}`);
  return JSON.parse(stdout) as T;
};

export const createBunChecker = ({ root, tsconfig }: CheckerOptions, version: string): TypeChecker => ({
  version: `${version} via bun check`,
  get inputs() {
    return programInputs(root, runScript<{ files: string[]; directories: string[] }>(root, [INPUTS_SCRIPT, tsconfig, root]));
  },
  check: (mutants) => (mutants.length === 0 ? new Map() : new Map(runScript<[string, string][]>(root, [CHECK_SCRIPT], JSON.stringify({ tsconfig, mutants })))),
  // Equivalence needs the checker's types, which Bun does not expose.
  equivalent: () => new Map(),
  close() {},
});

/**
 * Type errors from Bun's checker, equivalences from the project's TypeScript (Bun exposes no types).
 * The project's checker loaded the whole program, so its inputs cover what Bun reads.
 */
export const withBunErrors = (project: TypeChecker, bun: TypeChecker): TypeChecker => ({
  version: bun.version,
  get inputs() {
    return project.inputs;
  },
  check: (mutants) => bun.check(mutants),
  equivalent: (mutants) => project.equivalent(mutants),
  close: () => {
    project.close();
    bun.close();
  },
});
