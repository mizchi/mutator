# Survey of diff detection / incremental techniques — saved subagent report (key points)

## identity
- PIT: instruction index (MutationIdentifier.java:29-43) / Stryker: file@line:col + mutator + replacement + diff-match-patch relocation / mutmut: function name + sequence number + invalidation by function hash (__main__.py:198-215)
- Recommended: MutantKey = hash(file, scopePath, astPathInScope, mutatorId, replacement). No line/column. ScopeHash = hash of the normalized AST (excluding comments/whitespace/type annotations); when it changes, mutants in the scope are new

## Cache reuse decisions (extending PIT 1.22.0 IncrementalAnalyser:73-111)
| prev | Reuse condition | Otherwise |
|---|---|---|
| Killed | scope unchanged & killer exists and is unchanged | re-run with killer first |
| Survived | scope, depsHash, covering tests unchanged & no tests added | added/changed tests first |
| NoCoverage | scope unchanged & still zero coverage | normal |
| Timeout | scope & deps unchanged | normal |
| env (lockfile/tsconfig/runner config/node/tool/mutator ver) changed | invalidate all or warn (mutmut on_dependency_change) | |
- depsHash: Merkle composition of the scopeHashes reachable via the runtime call graph (or import graph) ← a gap in PIT/Stryker
- Store results as raw data before interceptors are applied (PIT HistoryResultInterceptor)
- Make coverage measurement itself incremental too (PIT History.limitTests, mutmut re-collects only new tests)
- From PIT 1.23.0 on, history moved to the paid arcmutate plugin

## Diff scope
- Google / cargo-mutants / Mull gitDiffRef / gremlins: mutate only changed hunks ∩ covered lines
- Test-only changes → re-run the Survived mutants covered by that test (Stryker's "added" rule)
- Test selection: per-test coverage primarily, call graph → module graph (vitest related) as auxiliary
- Overall score from periodic full runs or sampling (Gopinath 2015)

## Ranking / early exit
- previous killer → killers of sibling mutants → directly hitting tests (+1000 bonus, TestInfoPriorisationComparator.java:41-53) → fast, narrow tests. bail 1
- Mutants in order of shortest estimated time (mutmut :1014) or by survivability (Google)
- Weak mutation pre-check: compare the mutated value vs the original value and drop tests that are not infected. If none remain, it is an equivalent candidate

## arid (Google: arid(n) = simple(n) ? expert(n) : children.every(arid))
- Median 820 → 77 (1 mutant per line) → 7 (+arid), productive 80% → 89%
- Proposed JS rules: console/logger/debug, performance/OTel/metrics/Sentry, Date.now/performance.now/timer values, new Array(n)/Buffer.alloc, NODE_ENV/import.meta.env/import.meta.main, ===↔==, Math.min/max/clamp arguments, length<0 and similar, memo lookup, end/flush/close, toString/toJSON/getter, TS type syntax (as/satisfies/!/declare/.d.ts), generated code, assert/invariant arguments and error messages
- Declarative via ast-grep/config, grown from users' not-useful feedback

## Equivalence / redundancy reduction
- TCE (C: equivalent 7%, duplicate 21%) → JS approximation: compare hashes of the minified mutated scope
- subsumption (accumulate a kill matrix), mutant schemata (Untch 1993), lightweight EMS

## Reference URLs
Google 2018 https://research.google/pubs/state-of-mutation-testing-at-google/ / 2021 https://arxiv.org/abs/2102.11378 / Meta https://arxiv.org/abs/2010.13464 / Stryker incremental https://stryker-mutator.io/docs/stryker-js/incremental/ / Mull https://mull.readthedocs.io/en/0.31.0/IncrementalMutationTesting.html / TCE https://orbilu.uni.lu/bitstream/10993/20289/1/ICSE15.pdf / ReMT https://userweb.cs.txstate.edu/~rp31/papersSSE/regrMuteTest.pdf
Supporting sources: scratchpad/pit122/, scratchpad/ext/
