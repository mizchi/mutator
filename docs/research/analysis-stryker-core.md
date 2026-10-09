# stryker-js core / runners / checker analysis (commit f2a49ff) — saved subagent report (key points)

## Flow (core/src/stryker.ts:60-86)
Prepare (config/plugin/ProjectReader) → MutantInstrumenter (serial Babel instrumentation, preprocess, checker init, Sandbox.init: copies all files + symlinks node_modules) → DryRun (1 runner, overhead = gross - Σtest) → MutationTest (RxJS: earlyResult / check / NoCoverage / runner)

## Coverage
- header (instrumenter/src/util/syntax-helpers.ts:21-70): stryCov records perTest if currentTestId is set, otherwise static
- planner (mutant-test-planner.ts:88-138): non-static → covering tests, NoCoverage if empty / static → all tests + reloadEnvironment (Ignored if ignoreStatic)
- timeout = 1.5*netTime + 5000 + overhead, hitLimit = hits×100 (:184-187)
- No test ordering (no fastest-first / killer-first)

## Incremental (incremental-differ.ts)
- Character-level diff with diff-match-patch between the source embedded in the old report and the current source → position correction
- mutant key = `file@sl:sc-el:ec\nmutator: replacement`, test key = `file@line:col\nname`
- reuse: Killed if one of the old killers is the same / otherwise if no covering test was added / unconditionally if coverage is off
- A test's end is estimated as "the start of the next test" (:667-729)
- Limits: does not detect changes to dependency modules, config, or fixtures / dry run is always full / depends on the replacement string / no version or config hash / embeds all sources in the report, which bloats it

## Process model
- child_process.fork + JSON IPC + Proxy RPC, 1 process = 1 mutant at a time
- decorators: Retry → ReloadEnv → MaxReuse → Timeout (kill & refork) → ChildProxy
- switching: globalThis.__stryker__.activeMutant or env __STRYKER_ACTIVE_MUTANT__

## vitest-runner
- 1 Vitest per process (maxWorkers:1). Per mutant: provide('activeMutant') → re-evaluation via ctx.start(files)
- testNamePattern as an OR regex (over-runs tests with the same name), filesMap.clear() hack, a Vite server per process makes memory heavy
- per-test coverage: currentTestId set in the setup file's beforeEach/afterEach, written to suite.meta in afterAll

## typescript-checker
- In-memory SolutionBuilderWithWatch; groups mutants with non-overlapping ancestors via the import graph; groups with errors are re-checked individually
- Concurrency split in half between checker and runner

## Bottlenecks (estimated order)
1. Starting a test run per mutant 2. Recreating processes on timeout 3. Single dry run 4. TS checker 5. Serial Babel instrumentation 6. Sandbox copy 7. No ordering, so bail is less effective

## Design debt
Bloated typed-inject Context, RxJS, 1-bit reloadEnvironment capability, multi-language offset handling, JSON IPC + TCP logging, assorted hacks (ts-nocheck line correction, filesMap.clear)

## Implications
Parallel oxc instrumentation + content-hash IDs / resident runner that loads the SUT once / sort covering tests by time and kill history / cache dry run coverage keyed by transitive dependency hashes / resident tsgo checker
