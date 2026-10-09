// TypeScript >= 7: the native (tsgo) API with a virtual file system overlay.
import { readFileSync } from 'node:fs';
import type * as Native from 'typescript7/unstable/sync';
import { checkEach } from './diff.ts';
import type { CheckerOptions, TypeChecker } from './types.ts';

export function createNativeChecker(native: typeof Native, { root, tsconfig }: CheckerOptions, version: string): TypeChecker {
  const overlay = new Map<string, string>();
  const api = new native.API({ cwd: root, fs: { readFile: (file) => overlay.get(file) } });
  let snapshot = api.updateSnapshot({ openProjects: [tsconfig] });
  const project = () => {
    const p = snapshot.getProject(tsconfig);
    if (!p) throw new Error(`TypeScript could not load ${tsconfig}`);
    return p;
  };
  project();

  return {
    version,
    check(mutants) {
      return checkEach(
        mutants,
        (file) => readFileSync(file, 'utf8'),
        (file, text) => {
          const changed = text === undefined ? overlay.delete(file) : (overlay.set(file, text), true);
          if (changed) {
            const next = api.updateSnapshot({ fileChanges: { changed: [file] } });
            snapshot.dispose();
            snapshot = next;
          }
          const { program } = project();
          return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map((d) => `${d.code} ${d.text}`);
        },
      );
    },
    close() {
      snapshot.dispose();
      api.close();
    },
  };
}
