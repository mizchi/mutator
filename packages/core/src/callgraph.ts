// Experimental static call graph between scopes, resolved by name.
// It only sees calls written in the sources; values passed through test code
// (`f(g(x))` in a test) connect f and g without any edge here.
import type { CallSite, ImportBinding, Scope } from './types.ts';

export interface CallGraphSource {
  file: string;
  scopes: readonly Pick<Scope, 'id'>[];
  calls: readonly CallSite[];
  imports: readonly ImportBinding[];
}

/** scope key (`${file}#${scopeId}`) -> scope keys it calls */
export type CallGraph = Map<string, Set<string>>;

const key = (file: string, scope: string) => `${file}#${scope}`;
const isTopLevel = (scopeKey: string) => scopeKey.slice(scopeKey.indexOf('#') + 1).startsWith('<top');
const fileOf = (scopeKey: string) => scopeKey.slice(0, scopeKey.indexOf('#'));

export function buildCallGraph(sources: readonly CallGraphSource[], resolve: (from: string, specifier: string) => string | undefined): CallGraph {
  const idsByFile = new Map(sources.map((s) => [s.file, new Set(s.scopes.map((sc) => sc.id))]));
  const graph: CallGraph = new Map();

  for (const { file, calls, imports } of sources) {
    const ids = idsByFile.get(file)!;
    const bindings = new Map(imports.map((b) => [b.local, b]));
    const target = (scope: string, callee: string): string | undefined => {
      // functions declared inside the caller or one of its enclosing functions
      for (let prefix: string | undefined = scope; prefix; prefix = prefix.includes('>') ? prefix.slice(0, prefix.lastIndexOf('>')) : undefined) {
        if (ids.has(`${prefix}>${callee}`)) return key(file, `${prefix}>${callee}`);
      }
      if (callee.startsWith('this.')) {
        const method = scope.split('>')[0]!;
        const owner = method.includes('.') ? method.slice(0, method.lastIndexOf('.')) : undefined;
        const candidate = owner && `${owner}.${callee.slice(5)}`;
        if (candidate && ids.has(candidate)) return key(file, candidate);
        return undefined;
      }
      if (ids.has(callee)) return key(file, callee);
      const [head, ...rest] = callee.split('.');
      const binding = bindings.get(head!);
      if (!binding) return undefined;
      const other = resolve(file, binding.source);
      const otherIds = other && idsByFile.get(other);
      if (!other || !otherIds) return undefined;
      const name = binding.imported === '*' ? rest.join('.') : [binding.imported, ...rest].join('.');
      return otherIds.has(name) ? key(other, name) : undefined;
    };
    for (const { scope, callee } of calls) {
      const to = target(scope, callee);
      if (!to) continue;
      const from = key(file, scope);
      const edges = graph.get(from) ?? new Set();
      edges.add(to);
      graph.set(from, edges);
    }
  }
  return graph;
}

/**
 * `related(a, b)`: one scope can reach the other through calls (either direction),
 * or one of them is top-level code of the other's file.
 */
export function relatedScopes(graph: CallGraph): (a: string, b: string) => boolean {
  const reach = new Map<string, Set<string>>();
  const reachable = (from: string): Set<string> => {
    const cached = reach.get(from);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      for (const next of graph.get(stack.pop()!) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    reach.set(from, seen);
    return seen;
  };
  return (a, b) => {
    if (a === b) return true;
    if ((isTopLevel(a) || isTopLevel(b)) && fileOf(a) === fileOf(b)) return true;
    return reachable(a).has(b) || reachable(b).has(a);
  };
}
