// Module facts for the call graph: callees, references, top-level bindings, imports and re-exports.
import { parseSource } from './parse.ts';
import { type Frame, type Node, isFunction, unwrap, walk } from './ast.ts';
import type { ImportBinding, ImportScan } from './types.ts';

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
const OUT_OF_PROCESS = new Set(['node:child_process', 'child_process', 'node:worker_threads', 'worker_threads']);
const opaqueModule = (source: string) => OUT_OF_PROCESS.has(source) || source === 'node:module' || source === 'module';

/** Modules loaded by static imports and re-exports, in first-request order. */
export function moduleLoads(program: Node): string[] {
  const loads = new Set<string>();
  for (const st of program.body as Node[]) {
    const kind = st.type === 'ImportDeclaration' ? st.importKind : st.exportKind;
    if (st.source && kind !== 'type') loads.add(st.source.value);
  }
  return [...loads];
}

/**
 * Value imports and re-exports of a module, without instrumenting it, and the specifiers of
 * every module it loads statically (`loads`: side-effect imports included, type-only ones not).
 */
export function scanImports(file: string, source: string): ImportScan {
  const { program, errors } = parseSource(file, source);
  const loads = moduleLoads(program);
  const imports = importBindings(program);
  let opaque = errors.length > 0 || loads.some(opaqueModule);
  walk(program as unknown as Node, ({ node }) => {
    if (node.type === 'ImportExpression'
      && (node.source.type !== 'Literal' || typeof node.source.value !== 'string' || opaqueModule(node.source.value))) opaque = true;
    if (node.type === 'CallExpression' && ['require', 'module.require', 'createRequire', 'module.createRequire'].includes(calleeName(node.callee) ?? '')) opaque = true;
  });
  return { imports, reexports: reexportBindings(program), loads, ...(opaque ? { opaqueLoads: true as const } : {}) };
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

export { topLevelInfo } from '@mizchi/test-impact/source';

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
