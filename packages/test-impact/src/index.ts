import { existsSync, globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { changesSince } from './git.ts';
import { extractScopes, isTopLevelScope } from './source.ts';
import { normalizeRelativePath } from './paths.ts';
import { readObservations } from './observations.ts';
import type { SourceObservation } from './source-coverage.ts';
export { changesSince };
export { createSourceCoverageMapper, type ScriptCoverage, type SourceObservation } from './source-coverage.ts';
export { extractScopes };
export type { SourceScope } from './extract.ts';
export const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export type Changes = Readonly<Record<string, readonly number[] | null>>;
export interface ImpactMatch { file: string; test?: string; reason: string }
export interface ImpactResult { files: string[]; matches: ImpactMatch[]; typecheckFiles: string[] }
export type ImpactOptions = {
  root: string;
  /** Root-relative test files from the runner, or discover conventional filenames. */
  testFiles?: readonly string[];
  /** Complete test inventory per recorded file, with observations keyed by test ID. */
  observations?: Readonly<Record<string, Readonly<Record<string, SourceObservation>>>>;
} & ({ since: string; changes?: never } | { changes: Changes; since?: never });

/** Resolve a changed line to the enclosing functions. File-level edits require broader selection. */
function editedFunctions(root: string, file: string, lines: readonly number[] | null) {
  const path = resolve(root, file);
  if (!lines?.length || !existsSync(path) || !/\.[cm]?[jt]sx?$/.test(file)) return;
  const source = readFileSync(path, 'utf8');
  const sourceLines = source.split('\n');
  const scopes = extractScopes(path, source).filter(s => !isTopLevelScope(s.id));
  const keys = new Set<string>();
  for (const line of lines) {
    const touched = scopes.filter(s => s.location.start.line <= line && line <= s.location.end.line);
    const text = sourceLines[line - 1];
    // A function declaration may have an export modifier. Other surrounding
    // expressions or statements can execute without calling the function.
    if (text === undefined || !touched.some(({ location: { start, end } }) => {
      const prefix = start.line === line ? text.slice(0, start.column) : '';
      const suffix = end.line === line ? text.slice(end.column) : '';
      return /^\s*(?:export\s+(?:default\s+)?)?$/.test(prefix) && /^\s*;?\s*$/.test(suffix);
    })) return;
    for (const s of touched) keys.add(file + '#' + s.id);
  }
  return keys;
}

export async function selectAffectedTests(options: ImpactOptions): Promise<ImpactResult> {
  const root = resolve(options.root);
  const changes = options.changes ?? changesSince(root, options.since);
  const edits = new Map<string, readonly number[] | null>();
  for (const [name, lines] of Object.entries(changes)) {
    const file = normalizeRelativePath(name);
    const previous = edits.get(file);
    if (!lines?.length || previous === null) edits.set(file, null);
    else edits.set(file, previous ? [...new Set([...previous, ...lines])] : lines);
  }
  const observations = options.observations === undefined ? undefined : readObservations(options.observations, edits);
  const matches: ImpactMatch[] = [];
  const typecheckFiles = new Set<string>();
  if (!edits.size) return { files: [], matches, typecheckFiles: [] };
  const { dependencyReader, scriptFile } = await import('./dependencies.ts');
  const testFiles = options.testFiles ?? globSync('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', {
    cwd: root, exclude: ['**/node_modules/**', '**/.git/**', '**/.mutator/**', '**/.tmp/**', '**/dist/**', '**/coverage/**'],
  }).map(f => f.replaceAll('\\', '/')).filter(f => TEST_FILE.test(f));
  const reader = dependencyReader(root);
  const seen = new Set<string>();
  for (const group of observations?.values() ?? []) {
    for (const observation of group.values()) for (const scope of observation.scopes) seen.add(scope);
  }
  const changed = [...edits].map(([file, lines]) => {
    const keys = observations ? editedFunctions(root, file, lines) : undefined;
    return {
      file, observedScopes: keys && [...keys].every(key => seen.has(key)) ? keys : undefined,
      global: /(^|\/)(?:tsconfig[^/]*\.json|package\.json|(?:vite|vitest|jest|playwright)\.config\.[^/]+|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(file),
      deleted: !existsSync(resolve(root, file)),
    };
  });
  for (const test of [...new Set(testFiles.map(normalizeRelativePath))].sort()) {
    if (!existsSync(resolve(root, test))) continue;
    const deps = reader(test);
    const records = observations?.get(test);
    for (const { file, observedScopes, global, deleted } of changed) {
      const runtime = deps.runtime.has(file);
      if (deps.types.has(file) || global || deleted || deps.unknownTypes || /\.d\.[cm]?ts$/.test(file)) typecheckFiles.add(test);
      const reason = test === file ? 'changed' : global ? 'project configuration changed' : deleted ? 'removed dependency' : undefined;
      if (reason) { matches.push({ file: test, reason }); continue; }
      if (observations && scriptFile.test(file) && !TEST_FILE.test(file)) {
        if (!observedScopes || !records?.size) { matches.push({ file: test, reason: 'missing scope coverage for ' + file }); continue; }
        for (const [id, observation] of records) {
          const hit = observation.scopes.find(key => observedScopes.has(key));
          if (hit || !observation.complete) matches.push({ file: test, test: id, reason: hit ? 'executed ' + hit : 'incomplete coverage for ' + file });
        }
      } else if (runtime || deps.opaque) {
        matches.push({ file: test, reason: runtime ? 'imports ' + file : 'unresolved dependency for ' + file });
      }
    }
  }
  return { files: [...new Set(matches.map(m => m.file))], matches, typecheckFiles: [...typecheckFiles] };
}
