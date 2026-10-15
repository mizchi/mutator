// TypeScript >= 7: the native (tsgo) API with a virtual file system overlay.
import { readFileSync } from 'node:fs';
import type * as Native from 'typescript7/unstable/sync';
import { checkEach } from './diff.ts';
import { type AstNode, provenEquivalent } from './equivalent.ts';
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
    equivalent(mutants) {
      const { program, checker } = project();
      return provenEquivalent(mutants, (file) => readFileSync(file, 'utf8'), {
        honest: () => program.getCompilerOptions().noUncheckedIndexedAccess === true && !checker.isTypeAssignableTo(checker.getUndefinedType(), checker.getStringType()),
        sourceFile: (file) => program.getSourceFile(file) as unknown as AstNode | undefined,
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
