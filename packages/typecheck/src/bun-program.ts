// The program Bun's checker builds for a tsconfig, from `bun check --listFilesOnly --explainFiles`:
// its files, and which file imports which (type-only imports and `/// <reference>`s included).
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

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
  for (const line of output.split('\n')) {
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
  const { stdout } = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28, env });
  return parseExplainFiles(stdout ?? '', base);
};
