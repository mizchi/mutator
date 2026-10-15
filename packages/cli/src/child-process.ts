// Tests that run the project's code in a child process: mutants are applied in memory, so that
// process never sees them. The dry run records the commands; this finds what they may run.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { type SpawnedCommand, scanImports } from '@mizchi/mutator-core';
import type { ReportEntry } from './run.ts';

/** The warning heading the list of spawning tests. */
export const CHILD_PROCESS_WARNING = 'these tests run code in a child process; mutator cannot observe mutants there';
/** The label of an undetected mutant in a file such a process may load. */
export const POSSIBLY_IN_CHILD_PROCESS = 'possibly reached in a child process';

/** Why one spawning test matters (JSON and agent reports). */
export function childProcessMessage(command: string): string {
  return `this test runs \`${command}\` in a child process, where mutator cannot observe mutants: undetected mutants in the files it loads are ${POSSIBLY_IN_CHILD_PROCESS} and do not fail --fail-on-survived`;
}

const SCRIPT = /\.[cm]?[jt]sx?$/;

/** Project files (relative) a command runs: arguments naming files inside the root, outside node_modules. */
export function spawnedEntries(root: string, { argv, cwd }: SpawnedCommand): string[] {
  const out = new Set<string>();
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue;
    const rel = relative(root, resolvePath(cwd, arg));
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/).includes('node_modules')) continue;
    if (isFile(join(root, rel))) out.add(rel);
  }
  return [...out].sort();
}

/**
 * The spawning tests whose command runs a project file, and the local files those entries
 * load (relative, entries included), followed through static imports and re-exports.
 */
export function childProcessReach(input: {
  root: string;
  spawns: ReadonlyMap<string, readonly SpawnedCommand[]>;
  /** Relative import specifier -> local file (absolute). */
  resolve: (from: string, specifier: string) => string | undefined;
}): { tests: { test: string; command: string }[]; files: Set<string> } {
  const { root, resolve } = input;
  const tests: { test: string; command: string }[] = [];
  const files = new Set<string>();
  const pending: string[] = [];
  const add = (rel: string) => {
    if (!files.has(rel)) files.add(rel), pending.push(rel);
  };
  for (const [test, commands] of input.spawns) {
    for (const command of commands) {
      const entries = spawnedEntries(root, command);
      if (entries.length === 0) continue;
      tests.push({ test, command: command.argv.join(' ') });
      entries.forEach(add);
    }
  }
  while (pending.length > 0) {
    const file = join(root, pending.pop()!);
    for (const specifier of loadsOf(file)) {
      const target = resolve(file, specifier);
      if (target && !target.includes('/node_modules/')) add(relative(root, target));
    }
  }
  return { tests, files };
}

/** Keys of the undetected mutants (NoCoverage, Survived) in `files` (relative). */
export function possiblyInChildProcess(entries: readonly ReportEntry[], files: ReadonlySet<string>, root: string): string[] {
  return entries.filter((e) => (e.status === 'NoCoverage' || e.status === 'Survived') && files.has(relative(root, e.mutant.file))).map((e) => e.mutant.key);
}

function loadsOf(file: string): string[] {
  if (!SCRIPT.test(file)) return [];
  try {
    return scanImports(file, readFileSync(file, 'utf8')).loads;
  } catch {
    // Unparsable: what it loads is not followed.
    return [];
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
