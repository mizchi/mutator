// The program Bun's checker builds for a tsconfig, from `bun check --listFilesOnly --explainFiles`:
// its files, and which file imports which (type-only imports and `/// <reference>`s included).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

export type Program = Readonly<{
  files: readonly string[];
  /** Importer -> the files it imports. */
  imports: ReadonlyMap<string, readonly string[]>;
}>;

/** A diagnostic among the files: `file(1,2): error TS6053: …` or `error TS5023: …`, or a CI or agent form of one. */
const DIAGNOSTIC = /^(?:::|<|error TS\d+|.*\(\d+,\d+\): error )/;

/** Parses tsc-style `--explainFiles` output, whose paths are relative to `cwd`; Bun's bundled libs and diagnostics are left out. */
export const parseExplainFiles = (output: string, cwd: string): Program => {
  const files: string[] = [];
  const imports = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) {
      current = line.includes('://') || DIAGNOSTIC.test(line) ? undefined : resolve(cwd, line);
      if (current !== undefined) files.push(current);
      continue;
    }
    const importer = /^\s+(?:Imported|Referenced) via (["']).*?\1 from file '(.+?)'/.exec(line)?.[2];
    if (current === undefined || importer === undefined) continue;
    const from = resolve(cwd, importer);
    imports.set(from, [...(imports.get(from) ?? []), current]);
  }
  return { files, imports };
};

/** A path naming a file TypeScript reads, rather than a directory to include. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json)$/;

/**
 * The directory below which an `include` pattern, declared by a configuration in `from`, can match:
 * its part before the first wildcard, or the directory of a file it names (present or not yet).
 */
export const includeBase = (pattern: string, from: string, isFile: (path: string) => boolean): string => {
  const parts = pattern.split(/[\\/]/);
  const wildcard = parts.findIndex((part) => /[*?[{]/.test(part));
  if (wildcard < 0) {
    const base = resolve(from, pattern);
    return SOURCE_FILE.test(base) || isFile(base) ? dirname(base) : base;
  }
  // Each part keeps its separator, so that a root before the first wildcard (`/`, `C:\`) stays one.
  return resolve(from, parts.slice(0, wildcard).map((part) => `${part}/`).join(''));
};

/** Whether `file` reaches itself through its imports. */
export const inImportCycle = (file: string, imports: Program['imports']): boolean => {
  const seen = new Set<string>();
  const pending = [...(imports.get(file) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next === file) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(imports.get(next) ?? []));
  }
  return false;
};

/**
 * The program of `tsconfig`, listed by Bun's checker without type checking, with paths from `base`:
 * the working directory as the caller writes it (side effect: a `bun` process; run from Bun).
 */
export const readProgram = (tsconfig: string, base = process.cwd()): Program => {
  // These make Bun print diagnostics in agent or CI forms; the plain one is the most predictable.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['AGENT', 'CLAUDECODE', 'REPL_ID', 'GITHUB_ACTIONS'].includes(name)));
  const args = ['check', '-p', tsconfig, '--no-script', '--no-pretty', '--listFilesOnly', '--explainFiles'];
  const { status, signal, error, stdout, stderr } = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28, env });
  // A failed listing must not pass for a program without imports, whose cycles would go unseen.
  // Diagnostics of the configuration also exit non-zero, but list the files all the same.
  if (error || signal || (status !== 0 && !stdout?.trim())) throw new Error(`bun check --explainFiles failed: ${error?.message ?? signal ?? stderr}`);
  return parseExplainFiles(stdout, base);
};
