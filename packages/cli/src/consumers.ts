// Follows the names that side-effect-free top-level code declares to the code reading them.
// Shared by the dry-run planner (which tests to re-collect after an edit) and the static
// mutant test selection (which tests can observe a mutated declaration).
import { join, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { type ImportBinding, type Scope, scanImports } from '@mizchi/mutator-core';

/** What the planners need to know about each mutated source. */
export interface SourceInfo {
  scopes: readonly Scope[];
  imports: readonly ImportBinding[];
  reexports: readonly ImportBinding[];
}

export interface Importer {
  /** importing file (relative) */
  from: string;
  binding: ImportBinding;
  reexport: boolean;
  /** `from` is a mutated source (followed by name); otherwise it is invalidated */
  mutated: boolean;
}

export const isTopLevel = (scopeId: string) => scopeId.startsWith('<top');
const SCRIPT = /\.[cm]?[jt]sx?$/;

/**
 * Who imports what from whom (keys and `from` relative to root): the mutated sources, and the
 * `others` (test files, helpers) that are scripts and not mutated, parsed from disk.
 */
export function importGraph(input: {
  root: string;
  sources: ReadonlyMap<string, SourceInfo>;
  others: Iterable<string>;
  /** Relative import specifier -> one of the mutated files (absolute). */
  resolve: (from: string, specifier: string) => string | undefined;
}): Map<string, Importer[]> {
  const { root, sources, resolve } = input;
  const rel = (file: string) => relative(root, file);
  const importers = new Map<string, Importer[]>();
  const add = (from: string, imports: readonly ImportBinding[], reexport: boolean, mutated: boolean) => {
    for (const binding of imports) {
      const target = resolve(join(root, from), binding.source);
      if (!target) continue;
      const t = rel(target);
      importers.set(t, [...(importers.get(t) ?? []), { from, binding, reexport, mutated }]);
    }
  };
  const mutatedFiles = new Set<string>();
  for (const [file, info] of sources) {
    mutatedFiles.add(rel(file));
    add(rel(file), info.imports, false, true);
    add(rel(file), info.reexports, true, true);
  }
  for (const file of new Set(input.others)) {
    if (mutatedFiles.has(file) || !SCRIPT.test(file)) continue;
    const path = join(root, file);
    if (!existsSync(path)) continue;
    try {
      const { imports, reexports } = scanImports(path, readFileSync(path, 'utf8'));
      add(file, imports, false, false);
      add(file, reexports, true, false);
    } catch {
      // Unparsable: whatever it imports is not followed by name, but it is still reached through deps.
    }
  }
  return importers;
}

/**
 * Follows `seeds` (file, declared name) through the code that reads them:
 * - a function reading a name: `reach` is offered it, then its enclosing functions, until one
 *   returns true (the caller knows which tests ran it); a nested function runs only once its parent has.
 *   Without one, a plainly named function is followed by its own name (unless `skip` says
 *   nothing can call it), anything else invalidates its file.
 * - a top-level statement reading a name: followed by what it declares when side-effect free,
 *   otherwise its file is invalidated.
 * - an importer: mutated sources are followed by the local name, other files are invalidated.
 * Returns the invalidated files (relative): every test loading one of them is affected.
 */
export function followNames(input: {
  /** relative file -> scope id -> scope */
  scopes: ReadonlyMap<string, ReadonlyMap<string, Scope>>;
  importers: ReadonlyMap<string, readonly Importer[]>;
  seeds: Iterable<readonly [file: string, name: string]>;
  reach: (file: string, scopeId: string) => boolean;
  skip?: (file: string, scopeId: string) => boolean;
}): Set<string> {
  const { scopes, importers, reach } = input;
  const invalidated = new Set<string>();
  const pending: [file: string, name: string][] = [];
  const used = new Map<string, Set<string>>();
  const use = (file: string, name: string) => {
    const names = used.get(file) ?? new Set();
    used.set(file, names);
    if (!names.has(name)) names.add(name), pending.push([file, name]);
  };
  for (const [file, name] of input.seeds) use(file, name);

  while (pending.length > 0) {
    const [file, name] = pending.pop()!;
    for (const scope of scopes.get(file)?.values() ?? []) {
      if (!scope.refs?.includes(name)) continue;
      if (isTopLevel(scope.id)) {
        if (!scope.pure) invalidated.add(file);
        else for (const declared of scope.declares ?? []) use(file, declared);
        continue;
      }
      const segments = scope.id.split('>');
      let found = false;
      for (let n = segments.length; n > 0 && !found; n--) found = reach(file, segments.slice(0, n).join('>'));
      if (found || input.skip?.(file, scope.id)) continue;
      if (/^[\w$]+$/.test(scope.id)) use(file, scope.id);
      else invalidated.add(file);
    }
    for (const { from, binding, reexport, mutated } of importers.get(file) ?? []) {
      if (binding.imported !== '*' && binding.imported !== name) continue;
      if (!mutated) invalidated.add(from);
      else use(from, reexport && binding.local === '*' ? name : binding.local);
    }
  }
  return invalidated;
}

/** Test files loading `file` (directly or not), including `file` itself when it is a test file. */
export function loadersOf(file: string, deps: Readonly<Record<string, readonly string[]>>, testFiles: Readonly<Record<string, unknown>>): string[] {
  const hit = Object.entries(deps).filter(([, list]) => list.includes(file)).map(([t]) => t);
  if (file in testFiles) hit.push(file);
  return hit;
}
