// Without the project's `typescript`: Bun's own type checker (`bun check`, TypeScript 7),
// run in a `bun` child process (bun-check.ts) because only Bun can call it.
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckerOptions, TypeChecker, TypecheckInputs, TypecheckMutant } from './types.ts';

// Published builds ship bun-check.js next to bun.js.
const SCRIPT = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './bun-check.ts' : './bun-check.js', import.meta.url));
const BUN = process.versions.bun ? process.execPath : 'bun';
/** Mutants per build: a build holds a copy of the mutated file per mutant (about 0.5 MB each on a 300-line file). */
const CHUNK_SIZE = 200;

/** Runs `bun` in `root` (side effect: a child process). */
const bun = (root: string, args: readonly string[], input = '') => spawnSync(BUN, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, input });

/** The TypeScript version Bun type-checks with; undefined without `bun` or without its checker (before Bun 1.4). */
export const bunTypescriptVersion = (root: string): string | undefined => {
  const { status, stdout } = bun(root, ['-p', 'process.versions.typescript']);
  if (status !== 0) return undefined;
  const version = stdout.trim();
  return /^\d+\.\d+/.test(version) ? version : undefined;
};

/**
 * The files of the program (`--listFilesOnly`, without Bun's bundled libs) and the project
 * directories holding them, so that an added or removed source file invalidates cached verdicts.
 */
const programInputs = (root: string, tsconfig: string, listed: string): TypecheckInputs => {
  const files = listed.split('\n').filter(isAbsolute);
  const inProject = (file: string) => {
    const path = relative(root, file);
    return !path.startsWith('..') && !isAbsolute(path) && !path.split(sep).includes('node_modules');
  };
  return { files: [tsconfig, ...files], directories: [...new Set(files.filter(inProject).map(dirname))], directoryChecks: [], searches: [] };
};

/** The first new type error of each mutant that has one (side effect: a `bun` process). */
const checkChunk = (root: string, mutants: readonly TypecheckMutant[]): [string, string][] => {
  const { status, stdout, stderr, error } = bun(root, [SCRIPT], JSON.stringify({ mutants }));
  if (status !== 0) throw new Error(`bun type check failed: ${error?.message ?? stderr}`);
  return JSON.parse(stdout) as [string, string][];
};

export const createBunChecker = ({ root, tsconfig }: CheckerOptions, version: string): TypeChecker => ({
  version: `${version} via bun check`,
  get inputs() {
    return programInputs(root, tsconfig, bun(root, ['check', '-p', tsconfig, '--no-script', '--listFilesOnly']).stdout ?? '');
  },
  check(mutants) {
    const errors = new Map<string, string>();
    for (let i = 0; i < mutants.length; i += CHUNK_SIZE) {
      for (const [key, error] of checkChunk(root, mutants.slice(i, i + CHUNK_SIZE))) errors.set(key, error);
    }
    return errors;
  },
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
