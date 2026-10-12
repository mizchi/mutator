// Module facts for the call graph: callees, references, top-level bindings, imports and re-exports.
import { type ParserOptions, parseSync, rawTransferSupported } from 'oxc-parser';
import { type Frame, type Node, isFunction, unwrap } from './ast.ts';
import type { ImportBinding } from './types.ts';

export const RAW_TRANSFER = rawTransferSupported();

/** `f`, `a.b.c`, `this.m` — or undefined for computed / dynamic callees. */
export function calleeName(callee: Node): string | undefined {
  const n = unwrap(callee.type === 'ChainExpression' ? callee.expression : callee);
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') {
    const object = calleeName(n.object);
    return object && `${object}.${n.property.name}`;
  }
  return undefined;
}

/** `export ... from` statements, as bindings: `local` is the exported name (`*` for `export *`). */
export function reexportBindings(program: Node): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const st of program.body as Node[]) {
    if (st.exportKind === 'type' || !st.source) continue;
    if (st.type === 'ExportAllDeclaration') out.push({ local: st.exported ? moduleExportName(st.exported) : '*', imported: '*', source: st.source.value });
    else if (st.type === 'ExportNamedDeclaration') {
      for (const spec of st.specifiers as Node[]) {
        if (spec.exportKind !== 'type') out.push({ local: moduleExportName(spec.exported), imported: moduleExportName(spec.local), source: st.source.value });
      }
    }
  }
  return out;
}

const moduleExportName = (node: Node): string => node.name ?? node.value;

/** Value imports and re-exports of a module, without instrumenting it. */
export function scanImports(file: string, source: string): { imports: ImportBinding[]; reexports: ImportBinding[] } {
  const { program } = parseSync(file, source, { experimentalRawTransfer: RAW_TRANSFER } as ParserOptions);
  return { imports: importBindings(program), reexports: reexportBindings(program) };
}

/** Identifier references (not property names, object keys or labels). */
export function isReference(frame: Frame): boolean {
  const { node, parent, key } = frame;
  if (node.type !== 'Identifier' && node.type !== 'JSXIdentifier') return false;
  const p = parent?.node;
  if (!p) return false;
  if ((p.type === 'MemberExpression' || p.type === 'JSXMemberExpression') && key === 'property' && !p.computed) return false;
  if ((p.type === 'Property' || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && key === 'key' && !p.computed) return false;
  if (p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement') return false;
  if (isFunction(p) && key === 'id') return false;
  return true;
}

// Calls in a declaration's initializer count as defining the binding: what they do
// besides returning its value (e.g. registering into another module) is not tracked.
const IMPURE = new Set(['AssignmentExpression', 'UpdateExpression', 'YieldExpression', 'StaticBlock']);

/**
 * Bindings a top-level statement declares (exported names for `export { ... }`),
 * and whether evaluating it has no side effects. Imports, re-exports and types are
 * skipped by the walker and never become scopes.
 */
export function topLevelInfo(statement: Node): { declares: string[]; pure: boolean } {
  const declares: string[] = [];
  if (statement.type === 'ExportNamedDeclaration' && !statement.declaration) {
    return { declares: (statement.specifiers as Node[]).filter((s) => s.exportKind !== 'type').map((s) => moduleExportName(s.exported)), pure: true };
  }
  const decl = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
  if (statement.type === 'ExportDefaultDeclaration') declares.push('default');
  if (decl.type === 'VariableDeclaration') for (const d of decl.declarations) bindingNames(d.id, declares);
  else if ((decl.type === 'ClassDeclaration' || decl.type === 'FunctionDeclaration') && decl.id) declares.push(decl.id.name);
  else if (statement.type !== 'ExportDefaultDeclaration') return { declares, pure: false };
  let pure = true;
  const scan = (value: unknown): void => {
    if (!pure || typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) return value.forEach(scan);
    const node = value as Node;
    if (typeof node.type === 'string') {
      if (IMPURE.has(node.type)) pure = false;
      if (isFunction(node) || node.type === 'MethodDefinition') return; // bodies run later, not at load
    }
    for (const k in node) if (k !== 'parent') scan(node[k]);
  };
  scan(decl);
  return { declares, pure };
}

function bindingNames(pattern: Node, out: string[]): void {
  if (!pattern) return;
  if (pattern.type === 'Identifier') out.push(pattern.name);
  else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties) bindingNames(p.type === 'RestElement' ? p.argument : p.value, out);
  else if (pattern.type === 'ArrayPattern') for (const e of pattern.elements) bindingNames(e, out);
  else if (pattern.type === 'AssignmentPattern') bindingNames(pattern.left, out);
  else if (pattern.type === 'RestElement') bindingNames(pattern.argument, out);
}

export function importBindings(program: Node): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const st of program.body as Node[]) {
    if (st.type !== 'ImportDeclaration' || st.importKind === 'type') continue;
    for (const spec of st.specifiers as Node[]) {
      if (spec.importKind === 'type') continue;
      const imported =
        spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.type === 'ImportNamespaceSpecifier' ? '*' : (spec.imported.name ?? spec.imported.value);
      out.push({ local: spec.local.name, imported, source: st.source.value });
    }
  }
  return out;
}
