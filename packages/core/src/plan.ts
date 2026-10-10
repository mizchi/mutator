// Planner: decides per mutant whether to reuse a cached result, skip, or run (and with which tests).
// Pure functions only; inputs are the contract types from types.ts.
import type {
  Mutant,
  MutantResult,
  MutantStatus,
  PlanEntry,
  PlanInput,
  RunSnapshot,
  TestInfo,
} from './types.ts';

const DEFAULT_TIMEOUT_FACTOR = 1.5;
const DEFAULT_TIMEOUT_MS = 5000;

export function toResult(
  mutant: Mutant,
  status: MutantStatus,
  killedBy: string[],
  coveredBy: string[],
  durationMs?: number,
): MutantResult {
  const r: MutantResult = {
    key: mutant.key,
    file: mutant.file,
    scopeId: mutant.scope.id,
    scopeHash: mutant.scope.hash,
    status,
    killedBy,
    coveredBy,
  };
  if (durationMs !== undefined) r.durationMs = durationMs;
  return r;
}

const scopeKey = (file: string, scopeId: string) => `${file}#${scopeId}`;

function validPrevious(
  previous: RunSnapshot | undefined,
  toolVersion: string,
  envHash: string,
): RunSnapshot | undefined {
  return previous && previous.toolVersion === toolVersion && previous.envHash === envHash
    ? previous
    : undefined;
}

/** Tests that are new, removed, or whose fingerprint changed. */
function changedTests(previous: RunSnapshot, tests: readonly TestInfo[]): Set<string> {
  const before = new Map(previous.tests.map((t) => [t.id, t.fingerprint]));
  const now = new Set(tests.map((t) => t.id));
  const changed = new Set<string>();
  for (const t of tests) if (before.get(t.id) !== t.fingerprint) changed.add(t.id);
  for (const id of before.keys()) if (!now.has(id)) changed.add(id);
  return changed;
}

/** Test -> changed scopes (hash changed or disappeared) it previously covered. */
function changedScopesByTest(previous: RunSnapshot, mutants: readonly Mutant[], impacted: ReadonlySet<string> | undefined): Map<string, Set<string>> {
  const current = new Map(mutants.map((m) => [scopeKey(m.file, m.scope.id), m.scope.hash]));
  const out = new Map<string, Set<string>>();
  for (const r of previous.results) {
    const sk = scopeKey(r.file, r.scopeId);
    if (current.get(sk) === r.scopeHash && !impacted?.has(sk)) continue;
    for (const t of r.coveredBy) out.set(t, (out.get(t) ?? new Set()).add(sk));
  }
  return out;
}

export function plan(input: PlanInput): PlanEntry[] {
  const { mutants, tests, coverage, staticKeys } = input;
  const previous = validPrevious(input.previous, input.toolVersion, input.envHash);
  const factor = input.options?.timeoutFactor ?? DEFAULT_TIMEOUT_FACTOR;
  const timeoutConst = input.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const testById = new Map(tests.map((t) => [t.id, t]));
  const prevByKey = new Map(previous?.results.map((r) => [r.key, r]));
  const changed = previous ? changedTests(previous, tests) : new Set<string>();
  for (const t of input.affected?.tests ?? []) changed.add(t);
  const touched = previous ? changedScopesByTest(previous, mutants, input.affected?.scopes) : new Map<string, Set<string>>();
  const anyAffected = changed.size > 0 || touched.size > 0;
  // A test that ran changed code affects a mutant; with `related`, only when the
  // mutant's scope and the changed scope are connected (experimental call graph).
  const affects = (t: string, m: Mutant): boolean => {
    if (changed.has(t)) return true;
    const scopes = touched.get(t);
    if (!scopes) return false;
    if (!input.related) return true;
    const own = scopeKey(m.file, m.scope.id);
    for (const c of scopes) if (input.related(own, c)) return true;
    return false;
  };

  // test -> number of mutants it killed, per scope (for sibling-killer ordering)
  const killsByScope = new Map<string, Map<string, number>>();
  for (const r of previous?.results ?? []) {
    if (r.status !== 'Killed') continue;
    const sk = scopeKey(r.file, r.scopeId);
    const counts = killsByScope.get(sk) ?? new Map<string, number>();
    killsByScope.set(sk, counts);
    for (const t of r.killedBy) counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  const canReuse = (m: Mutant, prev: MutantResult, isStatic: boolean): boolean => {
    if (prev.scopeHash !== m.scope.hash || prev.file !== m.file) return false;
    const unaffected = (t: string) => !affects(t, m);
    if (prev.status === 'Killed') return prev.killedBy.some((t) => testById.has(t) && unaffected(t));
    // Re-checked every run: cheap, and the types it depends on may live in other files.
    if (prev.status === 'Ignored' || prev.status === 'Pending' || prev.status === 'CompileError') return false;
    // A static mutant influences every test through module loading, so any affected test invalidates it.
    if (isStatic && anyAffected) return false;
    if (!prev.coveredBy.every(unaffected)) return false;
    if (prev.status === 'Timeout' || prev.status === 'RuntimeError') return true;
    const now = coverage?.get(m.key);
    if (coverage && prev.status === 'NoCoverage' && (now?.length ?? 0) > 0) return false;
    const before = new Set(prev.coveredBy);
    return !(now ?? []).some((t) => !before.has(t));
  };

  const selectTests = (m: Mutant, prev: MutantResult | undefined, isStatic: boolean): string[] => {
    if (isStatic) return [...(input.staticTests?.get(m.key) ?? tests.map((t) => t.id))];
    if (coverage) return [...new Set(coverage.get(m.key) ?? [])];
    if (previous) return prev ? prev.coveredBy.filter((t) => testById.has(t)) : [];
    return tests.map((t) => t.id);
  };

  const order = (m: Mutant, prev: MutantResult | undefined, selected: string[]): string[] => {
    const killers = new Map((prev?.killedBy ?? []).map((t, i) => [t, i]));
    const siblings = killsByScope.get(scopeKey(m.file, m.scope.id)) ?? new Map<string, number>();
    // previous killers of this mutant count towards siblings too; subtract them out
    const ownKills = new Set(prev?.status === 'Killed' ? prev.killedBy : []);
    const siblingKills = (t: string) => (siblings.get(t) ?? 0) - (ownKills.has(t) ? 1 : 0);
    const duration = (t: string) => testById.get(t)?.durationMs ?? Infinity;
    const rank = (t: string): [number, number, number] => {
      const k = killers.get(t);
      if (k !== undefined) return [0, k, 0];
      const s = siblingKills(t);
      return s > 0 ? [1, -s, duration(t)] : [2, duration(t), 0];
    };
    return [...selected].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i]! < rb[i]! ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  };

  return mutants.map((m): PlanEntry => {
    if (m.ignored !== undefined) return { kind: 'ignored', mutant: m, reason: m.ignored };
    const isStatic = staticKeys.has(m.key);
    const prev = prevByKey.get(m.key);
    if (prev && canReuse(m, prev, isStatic)) return { kind: 'reuse', mutant: m, result: prev };
    let selected = selectTests(m, prev, isStatic);
    if (selected.length === 0) return { kind: 'noCoverage', mutant: m };
    if (m.weak && !isStatic && input.infection) {
      const { infected, observed } = input.infection;
      const infecting = new Set(infected.get(m.key) ?? []);
      selected = selected.filter((t) => !observed.has(t) || infecting.has(t));
      if (selected.length === 0) return { kind: 'notInfected', mutant: m };
    }
    const ordered = order(m, prev, selected);
    const total = ordered.reduce((sum, t) => sum + (testById.get(t)?.durationMs ?? 0), 0);
    return {
      kind: 'run',
      mutant: m,
      tests: ordered,
      isStatic,
      timeoutMs: Math.round(total * factor) + timeoutConst,
    };
  });
}

export function testsToRecollect(input: {
  mutants: readonly Mutant[];
  tests: readonly TestInfo[];
  previous: RunSnapshot | undefined;
  toolVersion: string;
  envHash: string;
}): { all: true } | { all: false; tests: string[]; unknownScopes: string[] } {
  const previous = validPrevious(input.previous, input.toolVersion, input.envHash);
  if (!previous) return { all: true };
  const current = new Set(input.tests.map((t) => t.id));
  const wanted = new Set([
    ...changedTests(previous, input.tests),
    ...changedScopesByTest(previous, input.mutants, undefined).keys(),
  ]);
  const known = new Set(previous.results.map((r) => scopeKey(r.file, r.scopeId)));
  const unknown = new Set(
    input.mutants
      .filter((m) => m.ignored === undefined)
      .map((m) => scopeKey(m.file, m.scope.id))
      .filter((s) => !known.has(s)),
  );
  return {
    all: false,
    tests: [...wanted].filter((t) => current.has(t)).sort(),
    unknownScopes: [...unknown].sort(),
  };
}

/**
 * Full current coverage = previous coverage (for unchanged mutants, minus re-measured tests)
 * ∪ freshly recollected coverage. The caller is responsible for validating `previous`
 * (tool/env) and for dropping tests that no longer exist.
 */
export function mergeCoverage(
  previous: RunSnapshot | undefined,
  recollected: ReadonlyMap<string, readonly string[]>,
  recollectedTests: readonly string[],
  mutants: readonly Mutant[],
): Map<string, string[]> {
  const remeasured = new Set(recollectedTests);
  const prevByKey = new Map(previous?.results.map((r) => [r.key, r]));
  const out = new Map<string, string[]>();
  for (const m of mutants) {
    if (m.ignored !== undefined) continue;
    const prev = prevByKey.get(m.key);
    const kept =
      prev && prev.scopeHash === m.scope.hash && prev.file === m.file
        ? prev.coveredBy.filter((t) => !remeasured.has(t))
        : [];
    out.set(m.key, [...new Set([...kept, ...(recollected.get(m.key) ?? [])])]);
  }
  return out;
}
