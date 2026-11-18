// TypeScript <= 6: a LanguageService over the project with in-memory overrides.
import { readFileSync } from 'node:fs';
import { dirname, normalize } from 'node:path';
import type * as TS from 'typescript6';
import { checkEach } from './diff.ts';
import { type AstNode, provenEquivalent } from './equivalent.ts';
import type { CheckerOptions, TypeChecker, TypecheckSearch } from './types.ts';
import { compilerPath } from './paths.ts';

export function createClassicChecker(ts: typeof TS, { tsconfig }: CheckerOptions): TypeChecker {
  tsconfig = compilerPath(tsconfig);
  const key = (file: string) => ts.sys.useCaseSensitiveFileNames ? compilerPath(file) : compilerPath(file).toLowerCase();
  const files = new Set<string>([normalize(tsconfig)]);
  const directories = new Set<string>();
  const directoryChecks = new Set<string>();
  const searches: TypecheckSearch[] = [];
  const sys: typeof ts.sys = {
    ...ts.sys,
    readFile: (file, encoding) => { files.add(normalize(file)); return ts.sys.readFile(file, encoding); },
    fileExists: (file) => { files.add(normalize(file)); return ts.sys.fileExists(file); },
    directoryExists: (directory) => { directoryChecks.add(normalize(directory)); return ts.sys.directoryExists(directory); },
    getDirectories: (directory) => { directories.add(normalize(directory)); return ts.sys.getDirectories(directory); },
    readDirectory: (directory, extensions, excludes, includes, depth) => {
      searches.push({ directory: normalize(directory), ...(extensions ? { extensions } : {}), ...(excludes ? { excludes } : {}), ...(includes ? { includes } : {}), ...(depth !== undefined ? { depth } : {}) });
      return ts.sys.readDirectory(directory, extensions, excludes, includes, depth);
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) throw new Error(`cannot parse ${tsconfig}`);
  const overrides = new Map<string, string>();
  const versions = new Map<string, number>();
  const host: TS.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: (file) => String(versions.get(key(file)) ?? 0),
    getScriptSnapshot: (file) => {
      const text = overrides.get(key(file)) ?? sys.readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dirname(tsconfig),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    fileExists: (file) => overrides.has(key(file)) || sys.fileExists(file),
    readFile: (file) => overrides.get(key(file)) ?? sys.readFile(file),
    readDirectory: sys.readDirectory,
    directoryExists: sys.directoryExists,
    getDirectories: sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const message = (d: TS.Diagnostic) => `${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;

  return {
    version: ts.version,
    get inputs() { return { files: [...files], directories: [...directories], directoryChecks: [...directoryChecks], searches }; },
    check(mutants) {
      return checkEach(
        mutants,
        (file) => readFileSync(file, 'utf8'),
        (file, text) => {
          file = compilerPath(file);
          if (text === undefined) overrides.delete(key(file));
          else overrides.set(key(file), text);
          versions.set(key(file), (versions.get(key(file)) ?? 0) + 1);
          return [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)].map(message);
        },
      );
    },
    equivalent(mutants) {
      const program = service.getProgram()!;
      const checker = program.getTypeChecker();
      return provenEquivalent(mutants, (file) => readFileSync(file, 'utf8'), {
        honest: () => program.getCompilerOptions().noUncheckedIndexedAccess === true && !checker.isTypeAssignableTo(checker.getUndefinedType(), checker.getStringType()),
        sourceFile: (file) => program.getSourceFile(compilerPath(file)) as unknown as AstNode | undefined,
        typesAt: (nodes) => nodes.map((node) => checker.getTypeAtLocation(node as unknown as TS.Node)),
        members: (type) => (type as TS.UnionOrIntersectionType).types,
        flags: ts.TypeFlags,
      });
    },
    close() {
      service.dispose();
    },
  };
}
