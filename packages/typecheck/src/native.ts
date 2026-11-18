// TypeScript >= 7: the native (tsgo) API with a virtual file system overlay.
import { readFileSync } from 'node:fs';
import { normalize } from 'node:path';
import type * as Native from 'typescript7/unstable/sync';
import { checkEach } from './diff.ts';
import { type AstNode, provenEquivalent } from './equivalent.ts';
import type { CheckerOptions, TypeChecker } from './types.ts';
import { compilerPath } from './paths.ts';

export function createNativeChecker(native: typeof Native, { root, tsconfig }: CheckerOptions, version: string): TypeChecker {
  tsconfig = compilerPath(tsconfig);
  const key = (file: string) => process.platform === 'win32' ? compilerPath(file).toLowerCase() : compilerPath(file);
  const overlay = new Map<string, string>();
  const files = new Set<string>([normalize(tsconfig)]);
  const directories = new Set<string>();
  const directoryChecks = new Set<string>();
  const api = new native.API({ cwd: root, fs: {
    readFile: (file) => { files.add(normalize(file)); return overlay.get(key(file)); },
    fileExists: (file) => { files.add(normalize(file)); return undefined; },
    directoryExists: (directory) => { directoryChecks.add(normalize(directory)); return undefined; },
    getAccessibleEntries: (directory) => { directories.add(normalize(directory)); return undefined; },
  } });
  let snapshot = api.updateSnapshot({ openProjects: [tsconfig] });
  const project = () => {
    const p = snapshot.getProject(tsconfig);
    if (!p) throw new Error(`TypeScript could not load ${tsconfig}`);
    return p;
  };
  project();

  return {
    version,
    get inputs() { return { files: [...files], directories: [...directories], directoryChecks: [...directoryChecks], searches: [] }; },
    check(mutants) {
      return checkEach(
        mutants,
        (file) => readFileSync(file, 'utf8'),
        (file, text) => {
          file = compilerPath(file);
          const changed = text === undefined ? overlay.delete(key(file)) : (overlay.set(key(file), text), true);
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
    equivalent(mutants) {
      const { program, checker } = project();
      return provenEquivalent(mutants, (file) => readFileSync(file, 'utf8'), {
        honest: () => program.getCompilerOptions().noUncheckedIndexedAccess === true && !checker.isTypeAssignableTo(checker.getUndefinedType(), checker.getStringType()),
        sourceFile: (file) => program.getSourceFile(compilerPath(file)) as unknown as AstNode | undefined,
        typesAt: (nodes) => (nodes.length ? checker.getTypeAtLocation(nodes as unknown as Parameters<typeof checker.getTypeAtLocation>[0]) : []),
        members: (type) => (type as Native.UnionOrIntersectionType).getTypes(),
        flags: native.TypeFlags,
      });
    },
    close() {
      snapshot.dispose();
      api.close();
    },
  };
}
