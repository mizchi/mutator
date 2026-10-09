# mutator design notes (draft)

Sources: `docs/research/` (stryker-js f2a49ff / cargo-mutants 9b09f6c / pitest 1.22.0 / Google and Meta papers / parser benchmarks). As of 2026-10-08.

## Goals

- Fast JS/TS mutation testing built on vitest
- **Diff-driven**: mutate only changed code, run only tests related to the change, reuse previous results for everything else
- A small, independent core library (no dependency on vitest / Node fs / process management)

## Why stryker is slow (findings)

1. It restarts a test run for every mutant (vitest: module re-evaluation via `ctx.start`, jest: `runCLI`)
2. It copies all files into a sandbox, and re-forks the process on timeout
3. The dry run is single-process and always full
4. No test ordering → bail is ineffective
5. Weak incremental mode: keyed by position + replacement string, does not detect dependency changes, cannot skip the dry run
6. Serial Babel instrumentation + a deep clone per mutant (O(M×S)) + full reprinting (though its contribution to wall time is small)
7. Complexity from the multi-runner abstraction (typed-inject / RxJS / the 1-bit reloadEnvironment capability)

## Layers

```
@mutator/core      Pure functions only. Input: (path, source, options) / diff / previous cache. Output: data
  ├─ instrument    oxc-parser + magic-string. Returns {code, map, mutants[]}
  ├─ mutators      Pure functions (node, parents, src) -> Replacement[]
  ├─ identity      Computes MutantKey / ScopeHash
  ├─ diff          unified diff parse → changed ranges → mutant selection
  ├─ plan          coverage + cache → execution plan (which mutants, in which test order)
  └─ cache         Reuse decisions (persisted format is serializable data only)
@mutator/vitest    vite plugin (enforce:'pre', core.instrument in transform), drives the Vitest Node API,
                   provide('activeMutant') switching, per-test coverage collection, worker pool, timeout
mutator (cli)      git invocation, fs, report output
```

Because instrument is a pure function, it can later be swapped for a Rust napi implementation (e.g. when oxc_semantic becomes necessary).

## instrument (inherited from stryker + improvements)

- **Inherited**: mutation switching, self-rewriting lazy helpers, `globalThis` namespace, infinite-loop detection via hitLimit, static/perTest coverage split, automatic hoisting to the nearest placeable ancestor, `.name` preservation, equivalence reduction in `&&`/`||` contexts, reporting ignored mutants too
- **Improved**: no AST clone/reprint; span + text composition instead (preserves formatting, with sourcemap); post-order composition of nested mutants; two-pass numbering with no ID gaps; consistent handling of `as`/`satisfies` (skip only the type part)
- **Guards we must implement ourselves**: parenthesization, ASI, never wrapping declarations / labeled loops / lexical declarations inside case with the statement placer
- Disable comments are redefined line-based from `Program.comments`

## Mutator policy

- Based on stryker's 17 mutators, plus cargo-mutants' **FnValue** (generate values from TS return type annotations: boolean→true/false, number→0/1/-1, string→""/"xyzzy", T[]→[], Promise<T>→…)
- Exclusions borrowed from cargo-mutants: no replacements prone to equivalence such as `==`→`<=`, unary operators are deletion-only, skip when the replacement equals the original, delete switch cases only when a default exists
- **Arid node suppression** (Google: `arid(n) = simple(n) ? expert(n) : children.every(arid)`): console/logger, tracing/metrics, `Date.now`, `process.env.NODE_ENV` / `import.meta.env`, `Math.min/max` arguments, `end/flush/close`, assert/invariant messages, etc. Rules can be added declaratively via config
- Option: one mutant per line (per statement) mode (Google: 820 → 7 per changelist)

## Diff-driven speedups (the main goal)

### 1. Mutant identity (position-independent)

```
MutantKey = hash(file, scopePath, astPathInScope, mutatorId, replacement)
ScopeHash = hash(normalized AST of the enclosing function; excluding comments, whitespace, type annotations)
```

- No line/column in the key (stryker / cargo-mutants / PIT are weak here)
- When a function's ScopeHash changes, mutants in that scope are treated as new (mutmut approach)
- At top level, each statement is one scope

### 2. Result cache and reuse decisions (PIT 1.22 + dependency hash)

| Previous | Reuse condition | Otherwise |
|---|---|---|
| Killed | ScopeHash unchanged & previous killer exists and is unchanged | Re-run with the killer first |
| Survived | ScopeHash, depsHash, covering tests unchanged & no covering tests added | Added/changed tests first |
| NoCoverage | ScopeHash unchanged & still zero coverage | Normal |
| Timeout | ScopeHash & depsHash unchanged | Normal |

- `depsHash`: Merkle composition of the ScopeHashes reachable via the runtime call graph (or the import graph if unavailable). Catches dependency changes that stryker / PIT ignore
- If `env` (lockfile / tsconfig / vitest config / node / tool / mutator set version) changes, invalidate everything
- Results are stored as raw data before filtering. Partial results are saved on interruption too
- **Coverage measurement (dry run) is itself diff-driven**: re-measure only tests that may touch changed scopes + new/changed tests

### 3. Diff scope (an improved cargo-mutants --in-diff)

- Calls git internally (`merge-base`, `-M --no-prefix`). With external diff input, checks that the new-side text matches the actual files (mismatch → dedicated exit code)
- Selection uses **range intersection**, not lines. `--scope=node|function` also offers a per-function mode that catches signature changes
- **Test-only changes** → re-run the Survived/NoCoverage mutants covered by those tests (cargo-mutants does nothing)
- Renames inherit cache entries via an old→new map

### 4. Test selection and execution order

- Narrow by per-test coverage (primary), with a module graph equivalent to `vitest related` (auxiliary)
- Order: previous killer → killers of sibling mutants → tests that hit directly → shortest runtime first. bail 1
- Mutants run in order of shortest estimated time
- timeout: baseline of the selected tests × factor + const

## Execution model (vitest adapter)

- PoC done (`docs/research/analysis-parsers.md`): pass an `enforce:'pre'` plugin to `createVitest` for in-memory instrumentation, switch via `provide` + `runTestFiles`. One transform, ≈ 50ms per mutant
- No sandbox copy (kept as opt-in for non-hermetic tests that write to fs)
- Static mutants go to a separate queue with module re-import
- The worker pool keeps N resident Vitest instances, recreated only on timeout
- Automatic snapshot updates are forbidden (equivalent to cargo-mutants' INSTA_UPDATE=no)

## Output (following cargo-mutants)

- `mutants.json` (all mutants, before start) / `outcomes.json` (incremental) / per-mutant diffs / GitHub annotations (`::warning`, missed only)
- exit code: baseline failure > timeout > survived > 0, separate code for diff mismatch
- shard `k/n`, `--list --json`

## Implementation status (2026-10-08)

- [x] core: instrument (18 mutators, 3 placement kinds, ASI guard), identity, scope hash, diff, plan
- [x] vitest: plugin, setup (perTest / static coverage, provide/inject switching), Session
- [x] cli: dry run → plan → run → snapshot, `--since`, reports, GitHub annotations
- [x] Disable comments (`// mutator-disable-next-line`, Stryker comment compatible)
- [x] Parallel execution (N Sessions, `-j`)
- [x] Diff-driven dry run (snapshot stores the test index / static / touched; only affected test files are re-collected)
- [x] Path-portable keys / snapshots (CI-cacheable)
- [x] Early exit via reporter observation + cancel rather than vitest `bail` (bail misses kills)
- [x] FnValue mutator (TS return types), Regex (own implementation roughly equivalent to weapon-regex level 1), CallExpression (`call();` → `;`, throw excluded), `for (;;)` → `for (;false;)`
- [x] Arid node suppression (logging callees, Google's compound rule. `--no-arid` / `--arid-callee`)
- [x] Test fingerprint includes the module graph (contents of helpers / fixtures; mutated source files contribute a residual hash)
- [x] ~~Multiple mutants per run~~ tried and dropped: the speedup came from Vitest worker parallelism within a run, not from amortizing fixed costs. With `-j 1` it went 186s→116s, but with the default `-j 6` it got worse, 57s→85s (early exit is less effective and the tail grows)
- [x] Reports: mutation-testing-elements JSON (schema v2) / HTML (`--reporter json|html`)
- [x] Publishing prep: dist via tsc, publishConfig, `pkf run pack-smoke`
- [x] Independent review (9 incremental-vs-cold mismatches): all turned into E2E tests and fixed

- [x] Type checking of mutants (`@mizchi/mutator-typecheck`): TS ≤ 6 via the compiler API, TS ≥ 7 via the native API; identical CompileError sets on ufo / pathe / cookie-es, native 3.5–7× faster
- [x] Config file (`mutator.config.{ts,mts,mjs,js,json}` + JSON Schema) and score thresholds (`thresholds.break` → exit 2)

## Experiment: narrowing re-runs with a static call graph (`--experimental-callgraph`)

In normal (sound) mode, every survivor covered by "tests that executed a changed function" is re-run.
Experimental mode additionally re-runs it only if "the survivor's function and the changed function are reachable from one another, in either direction, on the static call graph".
The call graph is built from the calls collected by instrument (`f()`, `obj.m()`, `this.m()`) and imports, resolved by name.
Values passed through test code (in `expect(f(g(x)))`, a change to f can alter whether a mutant in g is detected) do not become edges, so this is unsound.
It is therefore off by default, and switching modes invalidates the snapshot (included in the env hash).

`node scripts/callgraph-experiment.ts <root> <file> <from> <to>...` runs both modes from the same cold snapshot and
compares verdicts for mutants that "sound re-ran but callgraph reused". unjs/ufo, 4 semantics-preserving edits:

| Edit | sound | callgraph | Pruned | Verdict mismatches |
|---|---|---|---:|---:|
| `&& true` added to a `withoutBase` condition | 46 / 3.5s | 46 / 3.3s | 0 | 0 |
| `parseURL` concatenation → template literal | 578 / 14.8s | 175 / 6.7s | 403 | 0 |
| array order in `isRelative` | 19 / 3.1s | 17 / 3.3s | 2 | 0 |
| spread → `Object.assign` in `withQuery` | 89 / 6.2s | 58 / 5.1s | 34 | 0 |

It pays off for edits to functions that many tests pass through (parseURL). No misses in these 4 cases. However, semantics-changing edits or tests that compose values may produce mismatches, so we keep measuring.

## Benchmark (unjs/ufo, 7 files / 489 tests, M3 Pro 12 cores, 2026-10-09, idle machine)

| run | mutator | stryker 10 |
|---|---:|---:|
| cold (parallel, default) | **29s** (1109 mutants, 83.9%) | 36s (1016 mutants, 82.6%) |
| re-run with no changes | **0.33s** | 3.5s (`--incremental`) |
| after editing 1 function | **1.0s** (`--since HEAD`, 18 mutants run) / 10.7s (whole project, 48 mutants run) | 3.8s (`--incremental`) |

- Verdicts agree for the mutants both tools generate. Per-mutator generated and detected counts are also nearly the same.
- Measurement pitfalls (ones we actually hit):
  - Picking up duplicated tests from a leftover `.stryker-tmp/sandbox` in the ufo clone makes runs 2x slower (it is not in Vitest's default exclude)
  - forks pool workers were left behind as orphan processes after infinite-loop mutants timed out, and kept consuming CPU (fixed by defaulting to the threads pool). While they linger, every measurement swings by 2-3x. Numbers from earlier versions of this table (54s / 57s / 186s etc.) were affected by this

## Open questions

- parser: planning to adopt oxc-parser (npm, raw transfer). oxc is 0.x with frequent breaking changes, so pin the version
- Handling mutants that cause type errors (unviable): pre-check with a resident tsgo, or count runtime TypeErrors as killed
- Whether to be compatible with stryker's report schema (mutation-testing-elements)
- Priority of Vue/Svelte SFC support
