// TypeScript <= 6: a LanguageService over the project with in-memory overrides.
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type * as TS from 'typescript6';
import { checkEach } from './diff.ts';
import type { CheckerOptions, TypeChecker } from './types.ts';

export function createClassicChecker(ts: typeof TS, { tsconfig }: CheckerOptions): TypeChecker {
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) throw new Error(`cannot parse ${tsconfig}`);
  const overrides = new Map<string, string>();
  const versions = new Map<string, number>();
  const read = (file: string) => overrides.get(file) ?? readFileSync(file, 'utf8');
  const host: TS.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: (file) => String(versions.get(file) ?? 0),
    getScriptSnapshot: (file) => {
      const text = overrides.get(file) ?? ts.sys.readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dirname(tsconfig),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (file) => overrides.has(file) || ts.sys.fileExists(file),
    readFile: (file) => overrides.get(file) ?? ts.sys.readFile(file),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const message = (d: TS.Diagnostic) => `${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;

  return {
    version: ts.version,
    check(mutants) {
      return checkEach(
        mutants,
        (file) => readFileSync(file, 'utf8'),
        (file, text) => {
          if (text === undefined) overrides.delete(file);
          else overrides.set(file, text);
          versions.set(file, (versions.get(file) ?? 0) + 1);
          return [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)].map(message);
        },
      );
    },
    close() {
      service.dispose();
    },
  };
}
