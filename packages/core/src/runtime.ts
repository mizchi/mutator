export const RUNTIME_GLOBAL = '__mutator__';
export const RUNTIME_ACT = '__mutator_act';
export const RUNTIME_COV = '__mutator_cov';

/** Shape of `globalThis.__mutator__`, shared between instrumented code and the adapter. */
export interface RuntimeState {
  /** Key of the active mutant, or null for the original program. */
  active: string | null;
  cov: { static: Record<string, number>; perTest: Record<string, Record<string, number>> };
  /** Id of the running test; null while modules are loading (static coverage). */
  testId: string | null;
  hits: number;
  hitLimit: number;
}

export function createRuntimeState(init: Partial<RuntimeState> = {}): RuntimeState {
  return { active: null, cov: { static: {}, perTest: {} }, testId: null, hits: 0, hitLimit: Infinity, ...init };
}

// Read the namespace lazily on every call: modules may run before this header
// (circular imports) and adapters may swap the state object between runs.
export const runtimeHeader = [
  `function __mutator_ns() { return globalThis.${RUNTIME_GLOBAL} ??= { active: null, cov: { static: {}, perTest: {} }, testId: null, hits: 0, hitLimit: Infinity }; }`,
  `function ${RUNTIME_ACT}(id) { var ns = __mutator_ns(); if (ns.active !== id) return false; if (++ns.hits > ns.hitLimit) throw new Error("mutator: hit limit reached (" + ns.hits + ")"); return true; }`,
  `function ${RUNTIME_COV}() { var ns = __mutator_ns(), c = ns.testId == null ? ns.cov.static : (ns.cov.perTest[ns.testId] ??= {}); for (var i = 0; i < arguments.length; i++) c[arguments[i]] = (c[arguments[i]] || 0) + 1; }`,
].join('\n');
