// Resolve from each importer using its nearest project configuration. Cache direct
// edges across tests, including in graphs with circular imports or mixed type/value paths.
import ts from 'typescript';
import { builtinModules } from 'node:module';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { relativePath } from './paths.ts';

const builtins = new Set(builtinModules);
export const scriptFile = /\.[cm]?[jt]sx?$/;
type Edge = { file: string; typeOnly: boolean };
type Imports = { edges: Edge[]; opaque: boolean; unresolvedType: boolean };

export function dependencyReader(root: string) {
  const modules = new Map<string, Imports>();
  const configs = new Map<string, ts.CompilerOptions>();
  function options(file: string) {
    const config = ts.findConfigFile(dirname(file), name => !relative(root, name).startsWith('..' + sep) && ts.sys.fileExists(name));
    if (!config) return { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
    let opts = configs.get(config);
    if (!opts) {
      const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => { throw Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
      const error = parsed?.errors.find(d => d.code !== 18003);
      if (error) throw Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
      opts = parsed!.options;
      configs.set(config, opts);
    }
    return opts;
  }

  function imports(file: string): Imports {
    const cached = modules.get(file);
    if (cached) return cached;
    const out: Imports = { edges: [], opaque: false, unresolvedType: false };
    modules.set(file, out);
    const path = resolve(root, file);
    if (!scriptFile.test(file)) { out.opaque = extname(file) !== '.json'; return out; }
    const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const opts = options(path);
    function add(specifier: ts.Expression, typeOnly: boolean) {
      if (!ts.isStringLiteralLike(specifier)) { out.opaque = true; return; }
      const name = specifier.text;
      if (!typeOnly && /^(?:node:)?(?:child_process|worker_threads|module)$/.test(name)) out.opaque = true;
      if (name.startsWith('node:') || builtins.has(name)) return;
      const target = ts.resolveModuleName(name, path, opts, ts.sys).resolvedModule;
      if (!target) {
        if (typeOnly) out.unresolvedType = true;
        else out.opaque = true;
        return;
      }
      const local = relativePath(root, target.resolvedFileName);
      if (local.startsWith('../') || local.split('/').includes('node_modules')) return;
      out.edges.push({ file: local, typeOnly });
    }
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const list = clause?.namedBindings;
        const only = clause?.isTypeOnly || (!clause?.name && list && ts.isNamedImports(list) && list.elements.length > 0 && list.elements.every(e => e.isTypeOnly));
        add(node.moduleSpecifier, Boolean(only));
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const list = node.exportClause;
        add(node.moduleSpecifier, node.isTypeOnly || Boolean(list && ts.isNamedExports(list) && list.elements.length && list.elements.every(e => e.isTypeOnly)));
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        if (node.arguments[0]) add(node.arguments[0], false);
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['import.meta.glob', 'module.require'].includes(node.expression.getText(ast))) {
        out.opaque = true;
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        add(node.argument.literal, true);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        add(node.moduleReference.expression, node.isTypeOnly);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    return out;
  }

  return (test: string) => {
    const runtime = new Set<string>();
    const types = new Set<string>();
    let opaque = false;
    let unknownTypes = false;
    const visit = (file: string, typeOnly: boolean) => {
      if (runtime.has(file) || (typeOnly && types.has(file))) return;
      types.add(file);
      if (!typeOnly) runtime.add(file);
      const node = imports(file);
      if (node.unresolvedType || node.opaque) unknownTypes = true;
      if (!typeOnly && node.opaque) opaque = true;
      for (const edge of node.edges) visit(edge.file, typeOnly || edge.typeOnly);
    };
    visit(test, false);
    return { runtime, types, opaque, unknownTypes };
  };
}
