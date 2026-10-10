export const RUNTIME_GLOBAL = '__mutator__';
/** Module-level copy of the active mutant key, read once when the module evaluates. */
export const RUNTIME_ACTIVE = '__mutator_a';
/** Module-level flag: record coverage (dry runs only). */
export const RUNTIME_COLLECT = '__mutator_c';
export const RUNTIME_HIT = '__mutator_hit';
export const RUNTIME_COV = '__mutator_cov';
export const RUNTIME_WEAK = '__mutator_w';

/** Shape of `globalThis.__mutator__`, shared between instrumented code and the adapter. */
export interface RuntimeState {
  /** Key of the active mutant, or null for the original program. */
  active: string | null;
  /** Record coverage (dry runs). Mutant runs set false so instrumented code skips the counters. */
  collect?: boolean;
  cov: { static: Record<string, number>; perTest: Record<string, Record<string, number>> };
  /** Weak mutation: mutants whose value differed from the original's, per test. */
  inf?: { static: Record<string, number>; perTest: Record<string, Record<string, number>> };
  /** Id of the running test; null while modules are loading (static coverage). */
  testId: string | null;
  hits: number;
  hitLimit: number;
}

export function createRuntimeState(init: Partial<RuntimeState> = {}): RuntimeState {
  return { active: null, collect: true, cov: { static: {}, perTest: {} }, testId: null, hits: 0, hitLimit: Infinity, ...init };
}

/**
 * Per-module runtime, prepended to every instrumented file.
 *
 * - The active key and the collect flag are read once, when the module evaluates:
 *   adapters set them before the sources under test load (a fresh module graph per
 *   run), so with no mutant active the hot path is one string comparison per mutant.
 * - Coverage (dry runs only) uses typed arrays indexed by the file's mutant number:
 *   a key is added to the current test's set the first time the test reaches it, and
 *   counts are summed per module (`state.modules`) for hit limits.
 * - `var` keeps the reads harmless (undefined) if a module runs before its header
 *   through a circular import.
 */
export function runtimeHeader(keys: readonly string[]): string {
  return [
    `var __mutator_s = globalThis.${RUNTIME_GLOBAL} ??= { active: null, collect: true, cov: { static: {}, perTest: {} }, testId: null, hits: 0, hitLimit: Infinity };`,
    `var ${RUNTIME_ACTIVE} = __mutator_s.active, ${RUNTIME_COLLECT} = __mutator_s.collect !== false;`,
    `var __mutator_k = ${JSON.stringify(keys)}, __mutator_seen = new Int32Array(${keys.length}), __mutator_n = new Float64Array(${keys.length}), __mutator_t = {}, __mutator_g = 0;`,
    `if (${RUNTIME_COLLECT}) (__mutator_s.modules ??= []).push([__mutator_k, __mutator_n]);`,
    `function ${RUNTIME_HIT}() { var ns = globalThis.${RUNTIME_GLOBAL}; if (++ns.hits > ns.hitLimit) throw new Error("mutator: hit limit reached (" + ns.hits + ")"); return true; }`,
    // Weak mutation (dry runs only): the side-effect-free original value, then (mutant
    // index, mutated value) pairs; a difference marks the mutant as infected by the current test.
    `var __mutator_iseen = new Int32Array(${keys.length}), __mutator_it = {}, __mutator_ig = 0;`,
    `function ${RUNTIME_WEAK}(a) { var ns = __mutator_s, t = ns.testId; if (t !== __mutator_it) { __mutator_it = t; __mutator_ig++; } for (var i = 1; i < arguments.length; i += 2) { var j = arguments[i]; if (__mutator_iseen[j] === __mutator_ig || Object.is(a, arguments[i + 1])) continue; __mutator_iseen[j] = __mutator_ig; var inf = ns.inf ??= { static: {}, perTest: {} }; (t == null ? inf.static : (inf.perTest[t] ??= {}))[__mutator_k[j]] = 1; } }`,
    `function ${RUNTIME_COV}() { var ns = __mutator_s, t = ns.testId; if (t !== __mutator_t) { __mutator_t = t; __mutator_g++; } var c = null; for (var i = 0; i < arguments.length; i++) { var j = arguments[i]; __mutator_n[j]++; if (__mutator_seen[j] !== __mutator_g) { __mutator_seen[j] = __mutator_g; c ??= t == null ? ns.cov.static : (ns.cov.perTest[t] ??= {}); c[__mutator_k[j]] = 1; } } }`,
  ].join('\n');
}

/** Total hits per mutant key across the modules loaded by this runtime (dry runs). */
export function collectedCounts(state: { modules?: [readonly string[], ArrayLike<number>][] }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [keys, counts] of state.modules ?? []) {
    for (let i = 0; i < keys.length; i++) if (counts[i]) out[keys[i]!] = (out[keys[i]!] ?? 0) + counts[i]!;
  }
  return out;
}
