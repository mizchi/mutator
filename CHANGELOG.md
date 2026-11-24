# Changelog

## 0.5.5 - 2026-11-24

All eight npm packages share version **0.5.5**. The published code is the same as 0.5.4.

### Fixed

- A CLI test that starts the CLI six times through `sh` no longer times out on Windows runners. [#95](https://github.com/mizchi/mutator/pull/95)

## 0.5.4 - 2026-11-24

Faster cold runs, two new default mutators, opt-in skip rules and mutators, and fixes found by dogfooding. All eight npm packages share version **0.5.4**. Snapshots from 0.5.3 are not reused (the default mutant set changed), so the first run is cold.

### Added

- `MissingAwait` (`await p` -> `p`) and `RegexFlag` (a regex literal without one of its flags) run by default. Dropping the `await` of `return await p` outside a `try` and removing `g` from a pattern that can match only once (anchored, no `m`, cannot match empty) are skipped as equivalent (heuristic). `--exclude-mutator` turns either off. [#77](https://github.com/mizchi/mutator/pull/77) [#79](https://github.com/mizchi/mutator/pull/79) [#89](https://github.com/mizchi/mutator/pull/89)
- Opt-in mutators through `--enable-mutator <name>` / `enabledMutators`: `ArrayElement` and `ObjectProperty` remove one entry of a literal at a time. [#79](https://github.com/mizchi/mutator/pull/79)
- `mutator skipped [--format json]` lists the candidates that skip rules removed, with the rule, its category, the key and the mutant that justifies it. [#70](https://github.com/mizchi/mutator/pull/70)
- Opt-in skip and mutation options, all off by default. Changing any of them, or `--enable-mutator`, starts a cold run, since the mutants it adds have no cached coverage:
  - `--skip-subsumed` drops coarse mutants that have a finer mutant inside. [#75](https://github.com/mizchi/mutator/pull/75)
  - `--skip-hangs` drops mutants that likely never let a loop end. [#78](https://github.com/mizchi/mutator/pull/78)
  - `--minimal-relational` mutates `<`, `<=`, `>`, `>=` with the subsumption-minimal set and skips replacements a `.length` / `indexOf` bound proves equivalent. [#76](https://github.com/mizchi/mutator/pull/76)
- `MethodExpression` swaps `padStart` and `padEnd`. [#77](https://github.com/mizchi/mutator/pull/77)
- The `mutation-test-loop` skill keeps a ledger with a fixed set of verdicts and never takes expected values from the code under test. [#73](https://github.com/mizchi/mutator/pull/73)

### Changed

- Mutants are type-checked in a child process alongside their execution instead of before it: on ufo, a cold run spent 8.5 s waiting for the check. Cold runs of four benchmark projects are 10-20% faster. [#71](https://github.com/mizchi/mutator/pull/71)
- Cached verdicts are also keyed on the files and environment variables a test reads at run time (Vitest), so changing a fixture or an env var a test reads re-runs what it covered. [#74](https://github.com/mizchi/mutator/pull/74)

### Fixed

- Mutants no test reaches are type-checked too: one that does not compile is a `CompileError`, not a gap to close. [#82](https://github.com/mizchi/mutator/issues/82)
- An unchanged rerun no longer lists cached `CompileError` mutants as "to run". [#80](https://github.com/mizchi/mutator/issues/80)
- A subsumed skip is only justified by a mutant that runs, so a call removal is no longer dropped in favour of a `CompileError` inside it. [#83](https://github.com/mizchi/mutator/issues/83)
- An `--include` equal to the default include keeps the default cache; another selection that starts cold says so. [#81](https://github.com/mizchi/mutator/issues/81)
- `mutator skipped` reports 1-based columns, like the reports. [#84](https://github.com/mizchi/mutator/issues/84)
- With no mutant to score (e.g. `--since` and nothing in the diff) the summary says `n/a` instead of `100% [high]`, and the agent report's score is `null`. [#85](https://github.com/mizchi/mutator/issues/85)

## 0.5.3 - 2026-11-22

Fixes for instrumented code that did not parse. In each case one mutant made the whole instrumented file fail, so every test importing it failed at the baseline. All eight npm packages share version **0.5.3**.

### Fixed

- A function body whose directive has no semicolon (`function f() { 'use strict'` followed by a newline) no longer becomes `'use strict'if (…)` in the instrumented code. [#53](https://github.com/mizchi/mutator/issues/53)
- Operator swaps replace the operator itself, not a match inside a comment, and add a space where the new operator would join the code next to it: `o+-1` -> `o- -1` instead of `o--1`, and `a*/x/.lastIndex` -> `a/ /x/.lastIndex` instead of a line comment. A comment like `a /* a-b */ - b` used to be rewritten instead of the operator, so the mutant could never be detected. The keys of those mutants change; the others keep theirs. [#54](https://github.com/mizchi/mutator/issues/54)
- A function body that declares a function twice, or a function and a `var` with the same name (`var g; function g() {}`), no longer fails to parse. Such a body is not wrapped in a block anymore. Its whole-body mutants (`{}`, `{ return 0; }`) are placed around the function when it is an expression, and reported as `unplaceable` when it is a declaration. [#55](https://github.com/mizchi/mutator/issues/55)
- Removing `?.` right after an integer literal (`1?.toString()`) gives `1 .toString()` instead of `1.toString()`, which read the dot as a decimal point. The `?.` is also found past a comment before it. [#56](https://github.com/mizchi/mutator/issues/56)

## 0.5.2 - 2026-11-21

A fix for `mutator.accepted.json` in runs narrowed with `--include`. All eight npm packages share version **0.5.2**.

### Fixed

- A run of some files (`--include`) no longer lists the accepted mutants of the other files in `acceptance.stale` with `accepted, but the mutant no longer exists - remove from mutator.accepted.json`. Those mutants still exist, the run just does not hold them, and removing the entries made the next full run report them as undetected again. An entry is now judged only when the file in its `where` is among the files of the run or no longer exists; an entry without a `where` is judged as before. [#48](https://github.com/mizchi/mutator/issues/48)

## 0.5.1 - 2026-11-21

Fixes for Cloudflare Workers projects and for Vite 8.3 and older, and type checking for Bun projects without the `typescript` package. All eight npm packages share version **0.5.1**.

### Added

- Bun projects are type-checked with Bun's own checker (`bun check`, Bun 1.4+). Without the `typescript` package, `typecheck: 'auto'` used to turn type checking off without a message, so mutants that do not compile ran as tests. With the Bun runner and TypeScript 7 or newer, Bun's checker also finds the type errors, and equivalent mutants still come from the project's TypeScript. When no checker is available, `auto` logs why type checking is skipped and `typecheck: true` fails with the same reason. [PR #47](https://github.com/mizchi/mutator/pull/47)

### Fixed

- The Vitest adapter's dry run works in test workers that run on workerd (`@cloudflare/vitest-pool-workers`, `@cloudflare/vitest-plugin`). Every test file failed there with `The module.syncBuiltinESMExports method is not implemented`, so mutator stopped at `tests fail without mutants`. [PR #49](https://github.com/mizchi/mutator/pull/49)
- Sources with a regex literal that starts with `<!--` (for example `/<!--\s*pagebreak\s*-->/gi`) no longer fail the baseline on Vite 8.3 and older with `[PARSE_ERROR] HTML comments are not allowed in modules`. The parser in those versions (oxc before 0.159) rejects such a literal right after a grouping parenthesis, so the instrumented code now writes `(0, /<!--…/)` there. A mutant that cannot be written in a form those versions parse, such as removing the `!` of `!(/<!--/.test)(s)`, is reported as `unplaceable`. [#50](https://github.com/mizchi/mutator/issues/50) · [PR #51](https://github.com/mizchi/mutator/pull/51) · [PR #52](https://github.com/mizchi/mutator/pull/52)

## 0.5.0 - 2026-11-20

### Added

#### Run mutation tests with Bun

The experimental Bun adapter runs ESM JavaScript and TypeScript tests with `bun test --isolate`. The CLI runs on Node.js 24 or newer and needs Bun 1.4 or newer on `PATH`. To mutate TypeScript under `src/` and discover tests under `test/`, add these two files at the project root. [PR #45](https://github.com/mizchi/mutator/pull/45)

```ts
// mutator.config.ts
import { defineConfig } from '@mizchi/mutator';

export default defineConfig({
  runner: 'bun',
  include: ['src/**/*.ts'],
  bunConfig: 'bunfig.toml',
});
```

```toml
# bunfig.toml
[test]
root = "./test"
```

Run `pnpm exec mutator`. For example, tests that call `isAdult(age)` with 3 and 30 both pass when `age >= 18` becomes `age > 18`. The report marks that mutant `Survived`. Adding `expect(isAdult(18)).toBe(true)` makes it `Killed`.

#### Select affected tests before the first mutation run

`@mizchi/test-impact` provides a standalone CLI and Node API. If `test/checkout.test.ts` imports an edited `src/price.ts`, the following command lists the checkout test without running it. Use `--format json` to see why each file was selected.

```sh
pnpm add -D @mizchi/test-impact
pnpm exec test-impact --since HEAD
```

`mutator select-tests --since HEAD` now follows static imports when no snapshot exists. With a snapshot, it parses changed scopes and ranks tests using past kills and coverage. The standalone API also accepts per-test Chromium coverage to narrow the selection. [Test-impact guide](https://github.com/mizchi/mutator/tree/v0.5.0/packages/test-impact)

### Fixed

- **Diff reports agree on the score.** If both mutants in the diff are killed, the terminal and HTML report both show 100%, even when an unchanged file has a cached survivor. JSON marks out-of-selection mutants as `Pending`, and the kill matrix counts only selected mutants. [PR #29](https://github.com/mizchi/mutator/pull/29)
- **Reordering module initialization invalidates cached results.** Swapping two route registrations can change which handler runs first. An incremental run now rechecks the tests that load the module, including when the registrations differ only inside inline callbacks. Upgrading rebuilds the old snapshot on the next mutation run. [PR #30](https://github.com/mizchi/mutator/pull/30)
- **Deleted functions and renamed files keep their test history.** If a change removes `discount()` and edits `tax()`, `select-tests` can select tests of both functions. For a renamed module it also looks up tests importing the old path. [PR #31](https://github.com/mizchi/mutator/pull/31)
- **Broad include globs select source files.** `mutator --include 'src/domain/**'` accepts nested directories and skips files such as `README.md`. [PR #41](https://github.com/mizchi/mutator/pull/41)
- **The time budget covers mutant type checking.** With `--time-budget 30`, the checker consults the deadline between batches. Unchecked mutants remain `Pending` for the next run. [PR #42](https://github.com/mizchi/mutator/pull/42)
- **CLI failure output is easier to use.** A failing baseline names the test and shows its first error. When a Vitest test logs to stdout, `mutator --reporter agent > report.json` still writes a single JSON document and sends the test output to stderr. [PR #43](https://github.com/mizchi/mutator/pull/43) · [PR #39](https://github.com/mizchi/mutator/pull/39)
- Plugin examples import `definePlugin`, `defineMutator`, and `defineIgnorer` from the public `@mizchi/mutator` entry point so they resolve in pnpm projects. [PR #38](https://github.com/mizchi/mutator/pull/38)

## 0.4.5 - 2026-11-19

### Added

- Set `--max-workers` or `maxWorkers` in the config to cap active test workers across a mutator invocation. The baseline can use the full budget. During mutation testing, `-j 2 --max-workers 8` gives two concurrent Vitest or Playwright sessions up to four workers each. Jest runs each mutant in band.

### Changed

- Watch mode now waits one second before its initial run and groups edits into one-second windows. Use `--watch-throttle 5000` for five seconds or `--watch-throttle 0` for immediate scheduling. Continued edits keep the original deadline, and edits during a run queue one follow-up.

## 0.4.4 - 2026-11-19

### Added

- Use `--watch` to rerun mutation tests on edits. In Git it defaults to the working-tree diff against `HEAD` and includes mutants covered by changed tests.

### Fixed

- The installed Vitest adapter uses the project's Vitest for its worker setup when pnpm installs separate copies for different peer dependencies (#32).
- Git commands in repository fixtures, diff selection and shared-cache discovery use their target directory when invoked from a Git hook (#44).

## 0.4.3 - 2026-11-19

### Added

- **Progress for long runs.** After the baseline and type check, the CLI shows a progress bar when mutant execution is estimated to take at least 10 seconds or there are at least 100 mutants to run. The bar shows completed mutants, elapsed time and ETA on stderr. Redirected output keeps line-by-line progress, so `--reporter agent` still writes a single JSON document to stdout.
- **Resume after interruption.** Run the same command again after Ctrl-C or a terminated process. The CLI saves each completed verdict to a SQLite checkpoint, rechecks the baseline and type information on restart, and reports how many verdicts it restored. Unfinished mutants run again. Changes to sources, tracked tests or execution settings can invalidate saved verdicts.

## 0.4.2 - 2026-11-19

### Fixed

- Vitest/Vite+ runtimes installed next to the Vitest config file (`vitestConfig` / `--config`) resolve when the project root has no runner, as in a toolchain isolated in a sibling directory. Since 0.3.0 such projects failed with `neither vite-plus/test/node nor vitest/node resolves from <root>`. The root still wins when it has a runner, and the setup file's `vitest` import resolves from the same place as the runtime.

## 0.4.1 - 2026-11-19

Patch fixes for Vitest/Vite+ project coverage, cold include performance and Windows execution. All six npm packages share version **0.4.1**.

### Fixed

- Windows source include and test-file matching accept both native and Vite path separators (#24, PR #26).
- Vitest inline `test.projects` receive instrumentation and keep their own setup, test identities and cached project locations (#19). Snapshot compatibility is bumped to discard older project/path verdicts.
- Cold explicit `include` scopes in Vitest and Vite+ collect only related tests. Computed imports, CommonJS, child processes, workers and unsupported transforms retain a full dry run; `--full-dry-run` always collects all tests (#20).
- Filesystem transform caching stays disabled in every Vitest project, with regression coverage for alternating include sets (#22).
- Relative test IDs, mutant identities, cache keys and reports consistently use `/` on Windows. TypeScript 6/7 virtual file overlays normalize compiler paths; Jest and Playwright terminate server/process trees with Windows APIs (#25).
- Installed Vitest/Vite+ runtime paths resolve filesystem aliases and Windows 8.3 paths consistently. Playwright coverage accepts Windows source-map paths and native test locations.
- OXC uses the regular parser on Windows to avoid large raw-transfer reservations exhausting the system commit limit. On other platforms it falls back when the buffer cannot be reserved.

### CI

- npm publishing waits for complete Linux and Windows verification, shared with pull requests. Both OSes install the six packed packages outside the workspace in paths containing spaces and exercise Vitest, Vite+, Jest, Playwright, shipped skills and Playwright source coverage. POSIX-only signal/orphan tests remain on Linux.

## 0.4.0 - 2026-11-18

This release brings Vite+ (`vp test`) compatibility and opt-in Playwright source coverage, alongside runtime estimates and CI sharding. All six npm packages share version **0.4.0**; these are the changes since 0.3.0.

### Added

#### Vite+ (`vp test`)

Projects using `vp test` can use the existing Vitest adapter. Runner detection recognizes the project's Vite+ installation or Vite config; configuration stays in `vite.config.ts` and tests import their API from `vite-plus/test`:

```ts
// vite.config.ts
import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
```

```ts
// test/example.test.ts
import { expect, test } from 'vite-plus/test';
```

Install `@mizchi/mutator@0.4.0` in the existing Vite+ project and run `pnpm exec mutator`. The adapter resolves the project's `vite-plus/test/node` API before standalone Vitest and injects setup through the matching `vite-plus/test` API, so another installed Vitest version does not split the runtimes. Integration tests cover Vite+ 1.7.0 alongside standalone Vitest 5.1.0. See the [Vite+ setup notes](https://github.com/mizchi/mutator#vite-vite-plus).

#### Playwright E2E: explicit opt-in and original-source coverage

Browser mutation testing through a Vite dev server is experimental and must now be enabled explicitly. Installing Playwright or adding its config no longer selects it automatically; `runner: 'auto'` selects Vitest or Jest.

For an existing Playwright + Vite app, install the CLI and adapter:

```sh
pnpm add -D @mizchi/mutator@0.4.0 @mizchi/mutator-playwright@0.4.0
pnpm exec playwright install chromium
```

The app needs `mutatorVite()` from `@mizchi/mutator-playwright/vite`, and the Playwright config must start Vite through `webServer`. Tests use the adapter's fixture:

```ts
import { expect, test } from '@mizchi/mutator-playwright';
```

The [setup guide](https://github.com/mizchi/mutator#playwright-experimental) covers the complete wiring. Enable the runner in `mutator.config.ts`:

```ts
import { defineConfig } from '@mizchi/mutator';

export default defineConfig({
  runner: 'playwright',
  playwrightConfig: 'playwright.config.ts',
  include: ['src/**/*.ts', 'src/**/*.tsx'],
  concurrency: 2,
  timeBudget: 300,
  playwrightSourceCoverage: true, // optional; Chromium only, default false
});
```

The optional `playwrightSourceCoverage` collector maps Chromium V8 execution ranges through inline source maps back to original function scopes. It records which E2E executed each function, including functions with no mutation candidates. The snapshot stores this correspondence for incremental dry runs and `mutator select-tests --since main`; source-only edits also invalidate mutation verdicts from affected tests. Missing/stale maps, navigations, frames and workers retain conservative candidates. New sources without historical dependencies fall back to all E2Es.

**Runtime cost:** browser mutation testing can take many minutes or hours on a large app because each mutant starts a Playwright process. The additional V8 collector runs in dry runs only and is disabled by default. In the synthetic large benchmark (16,392 mutants, 32 E2Es; median of three runs), enabling it increased dry-run time from **5.00s to 8.82s** with one worker and **3.32s to 4.88s** with four workers. The function correspondence index is about **244kB**. See the [measurements and reproduction commands](https://github.com/mizchi/mutator/blob/main/docs/playwright-coverage-benchmark.md).

The [runnable cart/profile sample](https://github.com/mizchi/mutator/blob/main/examples/playwright-source-coverage/README.md) includes all configs and a verifier. It checks ordinary E2Es, source correspondence, unchanged cache reuse, source-only edits and agreement between incremental and cold full runs. From a repository checkout:

```sh
pnpm install --frozen-lockfile
pnpm --dir examples/playwright-source-coverage exec playwright install chromium
pnpm --dir examples/playwright-source-coverage run verify
```

The verified sample kills all 9 mutants initially, reuses all 9 unchanged, then re-tests 5 and reuses 4 after editing a helper without mutants. README and packaged skills link to the sample.

#### Large runs and CI

- Runtime estimates after the baseline and type checking. Large mutation runs show an ETA calibrated from observed timings and a progress heartbeat every 15 seconds.
- `--shard INDEX/COUNT` partitions mutant keys deterministically across CI jobs. Each shard keeps independent snapshots and default report directories; scores and quality gates cover that shard.
- The GitHub Action accepts a `shard` input that also separates its cache keys.

### Changed

- **Upgrade note:** Playwright users must set `runner: 'playwright'` or `playwrightConfig` in `mutator.config.ts`, or pass an explicit `--runner playwright` / `--playwright-config` flag. Keep browser specs outside the unit runner's include patterns. Chromium is required only for the optional V8 source collector; the regular Playwright adapter remains available without it.
- The snapshot version is bumped: the first run after upgrading rebuilds incompatible cached coverage and verdicts.
- The repository's mutation workflow runs four shards and uploads a report artifact for each, even when a quality gate fails.
- Update Vitest to 5.1.0, Playwright to 1.65.1, Vite to 8.3.8, oxc-parser to 0.159.0, magic-string to 1.4.5, Secretlint to 14.0.1 and Node type definitions to 26.6.6. Secretlint's recommended preset is built in, so the separate deprecated package is removed. TypeScript 6 compatibility tests are retained.
- Releases use newly created full-version tags only. Existing tags remain immutable.

### Fixed

- Default runner detection no longer starts Playwright from its config files or installed package. Browser mutation testing is opt-in through an explicit runner or Playwright config option, with setup and runtime-cost guidance.
- Vite+ sessions resolve the project's `vite-plus/test/node` and `vite-plus/test` APIs together, preventing another installed Vitest or a package exposed only through `NODE_PATH` from being selected.
- Mutation sessions disable the persistent module cache so every session populates its own mutant registry, including repeated and parallel runs.

## 0.3.0 - 2026-11-17

### Added

- `--include-test-changes` extends `--since` to code covered or imported by added, edited or removed tests. Reports include the tests that selected each mutant, and unresolved findings remain visible when the same diff is checked again.
- `--shared-cache` reuses validated snapshots across Git worktrees, separated by package, source scope and environment.
- JSON and agent reports expose severity-tagged `findings`, `selectionReasons`, `testChanges` and `comparison`. Detection-regression findings identify unchanged code that tests detected before but no longer detect; an unavailable previous snapshot is reported explicitly.
- `--kill-matrix` includes an `observations` record for every collected test: `detected`, `noKills`, `notReached` or `incomplete`. New tests with no kills and tests whose detection power was not measured are reported separately.
- The opt-in `numericMutations` plugin adds `MathRounding` and `NumericConstant` mutants for rounding methods and explicitly configured constants, including negative values. Custom mutator factories can set `cacheKey` to invalidate results when captured configuration changes.

### Changed

- Type-check verdicts, including `CompileError` and equivalence decisions, are cached against the source and compiler inputs. Unchanged reruns skip the checker; declaration, configuration, resolution and file-discovery changes invalidate the cache. The exported `TypeChecker` contract now exposes these inputs.
- Each include/exclude scope keeps its own snapshot under `.mutator/scopes/`, so alternating between scopes preserves their results. `.mutator/snapshot.json` continues to contain the latest run for existing scripts.
- The snapshot version is bumped: the first run after upgrading rebuilds incompatible cached results.

### Fixed

- Directory-existence probes track existence separately from entry listings, so parallel work in sibling projects no longer invalidates an unchanged project's type-check results.
- Changes to enclosing workspace manifests and lockfiles invalidate package caches in pnpm/npm monorepos. Workspace discovery stops at the repository boundary.
- Unresolved regressions caused by removed killing tests remain reported on subsequent `--since` runs instead of disappearing after the first recheck.
- Incomplete kill matrices no longer establish that a test detects nothing or is subsumed by another test. Early exits, timeouts and pending work are distinguished from complete measurements.
- Snapshot writes and updates to the latest-run snapshot are atomic, preventing readers from observing partially written JSON.

These changes incorporate feedback from [mizchi/mutator を入れてみた](https://zenn.dev/polyco/articles/e05cb28c569801) ([#18](https://github.com/mizchi/mutator/pull/18)).

## 0.2.0 - 2026-10-22

- The `mutation-test-loop` agent skill ships with `@mizchi/mutator`, and `mutator init-skill [--dir <dir>] [--force]` copies it into the project (default `.claude/skills`). It refuses to overwrite an edited copy unless `--force` (#12).
- The child-process warning lists one line per test file, with the number of its spawning tests and the project files they run, instead of every command (#10).
- Jest runner: a mutant whose failing tests span several test files is now `Killed` with its killing test recorded, instead of `RuntimeError` with none. Jest's `--bail` exited before writing its JSON report; each finished test file is now recorded as it completes. A test file that fails to load is still a `RuntimeError` (#13).
- A mutant run that runs out of time is re-run once with 3x the budget before it is reported as `Timeout`, so a machine that is busier than during the dry run no longer turns slow kills and survivors into timeouts (or drops them from `--kill-matrix`). Runs stopped by the hit limit are not re-run. The summary reports how many runs were re-run (#14).
- A GitHub Action (`uses: mizchi/mutator@v0`) runs mutator on the pull request's diff and keeps `.mutator/` in the Actions cache (#11).
- A changed test file that the runner's config excludes on purpose (Vitest `exclude`) is no longer reported as not collected (#10).
- Playwright runner (experimental): `--runner playwright` mutates browser code that Playwright Test drives through a Vite dev server, with `@mizchi/mutator-playwright` (a Vite plugin and a test fixture). Playwright's artifacts go to mutator's temporary directory, not the project (#15).
- Playwright: mutant runs bound `expect` timeouts to at least 1 s (was 2 s), and results come from mutator's own reporter: the fixture app runs in 39.5 s instead of 59.4 s with the same verdicts (#16).
- The CLI flushes stdout before it exits: a report larger than a pipe's buffer (64 KB), such as `--reporter agent` piped to `jq`, was cut off.
- Playwright: a `webServer` with neither `url` nor `port` is reported as such (it was taken for a server already answering); Playwright's artifacts stay out of the project even when its config fails to load.
- Agent skills for using mutator, shipped under `skills/` (skills-npm convention): `mutator` (setup, config, reports, CI) in `@mizchi/mutator` next to `mutation-test-loop`, and `mutator-playwright` in `@mizchi/mutator-playwright`. `mutator init-skill` now copies every skill the CLI ships, with its reference files.
- Critical regions: a critical mutant left unrun (`--time-budget`, `--mutants-per-line`) fails the gate, and on GitHub Actions undetected critical mutants are `::error` annotations titled `Critical mutant ...` (also unreached ones in full runs).
- A runner that cannot start (a Playwright config it cannot list, a dev server that fails or a port in use) exits 1 with its message instead of a stack trace.
- Playwright: a test file depends on the local files it imports (helpers, fixtures), so editing one re-collects its coverage.
- A run whose tests reach no mutant at all warns that the setup (include, instrumentation) is likely wrong (`noCoverage` in the agent report). It is decided from coverage, so reached mutants left pending by `--time-budget` do not trigger it.
- A plugin module that exports nothing usable (a misspelt `visit`, a missing name) is a config error saying what is missing.
- A mutant reached while a test file loads (or in its `beforeAll`) ran only that file's tests, not the tests of other files that reach it while running, so it could be reported Survived although one of those kills it. Both run now; the snapshot version is bumped so such cached verdicts are not reused.
- A `RuntimeError` is re-run once and counts only if it fails the same way again: under load, an unhandled error from a flaky test file was credited as a detection of whatever mutant was running (seen as bursts of RuntimeError that the same mutants did not reproduce alone, where they survive).
- Ctrl-C and SIGTERM kill every process the run started before exiting (130 / 143). A worker stuck in a mutant's loop used to keep spinning at full CPU after mutator was stopped.
- Playwright tests of this repository no longer depend on the machine's load (the timeout test hangs on purpose; the expect-bound test compares with a passing run).
- After a run killed with SIGKILL, the next run stops the workers it left spinning (recorded under `.mutator/processes/` with their start time; only those still orphaned and started when recorded).
- Vite+ projects run as Vitest projects: an installed `vite-plus` selects Vitest when there is no config file (it worked only through the NODE_PATH that pnpm's bin shims set), and tests may import from `vite-plus/test`.
- Playwright: a mutant run stopped by the hit limit is a `Timeout` (`hitLimit`); it was reported `Killed` by the test that hit it.
- Jest: `weakMutation: false` reaches Jest's transformer; the workers still compiled weak-mutation probes.
- One classification of mutant runs for every runner. Vitest: a test file whose only load errors come from the hit limit is a `Timeout`, not a `RuntimeError`. Jest: a test failing on the hit limit and on something else is `Killed`, not `Timeout`. `killedBy` lists the tests, then the files, without duplicates.
- Plugin modules loaded by the Jest transformer and the Playwright Vite plugin get the CLI's checks and messages. The plugin fingerprint changes, so cached results of runs with plugins are run again once.
- `ConditionalExpression` looks through `<T>x` assertions: `if (<boolean>(a > b))` no longer gets the same `true` / `false` mutants twice.
- `ranges` keeps an insertion mutant on a range edge, as `--since` does.
- `--time-budget` also stops the remaining parts of a long run split by test file; a run stopped between parts stays `Pending`. Every started run used to finish all its parts, which overran a 600 s budget by more than 30 minutes.

## 0.1.0 - 2026-10-16

First release.

### Running

- Vitest runner: sources are instrumented in memory by a Vite `transform` hook (mutation switching, one compile), and each mutant runs only the tests that cover it, on parallel single-worker Vitest instances.
- Jest runner for native ESM projects (experimental). `--runner vitest|jest|auto` picks the runner.
- Results are reused across runs. A mutant's identity does not depend on its position, and each result is cached with the hash of its enclosing function. Unchanged code with unchanged covering tests is not run again, and the coverage run skips the test files a change cannot affect.
- `--since <ref>` runs and reports only the mutants in `git diff <ref>`. It also rechecks mutants outside the diff that were killed before by tests that no longer exist.
- Weak mutation: mutants that no test infects are decided without running them.
- Mutants are type-checked with the project's own TypeScript (6 through the compiler API, 7 through the native API). Mutants that do not compile are reported as `CompileError` and not run.
- `--mutants-per-line` and `--time-budget` bound large runs. Long runs are split by test file across idle sessions.
- A stall timeout and hit limits stop mutants stuck in loops.

### Mutants

- Built-in mutators come with StrykerJS-style disable comments.
- Logging-only code is suppressed under Google's arid-node rule.
- Plugins can add custom mutators and ignorers.
- `--experimental-callgraph` narrows re-runs after an edit using a static call graph.
- With `strictNullChecks` and `noUncheckedIndexedAccess`, `?.` mutants on values that are never nullish are proven equivalent by types and are not run (#5).

### Reporting

- Undetected mutants are listed in three groups, each with its own fix: not detected, not infected and not reached. See [docs/coverage-and-mutation.md](docs/coverage-and-mutation.md).
- Text summary, GitHub annotations, and the mutation-testing-elements JSON and HTML reporters.
- Config file (`mutator.config.*`), score thresholds, `--fail-on-survived`, and documented exit codes.
- With `--since`, mutator warns about changed test files that the runner does not collect (#1) and about skipped or todo tests on changed lines.
- `mutator accept <key> --reason ...` records equivalent survivors in `mutator.accepted.json`. They are reported as `Ignored`, and the summary lists entries that are killed now or stale (#2).
- Tests that run the sources in a child process are reported. Undetected mutants in the code those processes load are labelled "possibly reached in a child process" and are not counted by `--fail-on-survived` (#4).
- Critical regions (`critical` globs, `--critical` or `// mutator-critical`): every mutant in them must be killed or accepted, otherwise the run exits 2 (#8).
- `--reporter simplify` lists removals that no test observes, as code that may be unnecessary (#9).

### Agents and test selection

- `--reporter agent` prints JSON on stdout for coding agents. `--only <key>` re-checks just the given mutants. The `mutation-test-loop` skill runs the loop with Claude Code (#3).
- `mutator select-tests --since <ref>` ranks the tests a change can break, from a warm snapshot (#6).
- `--kill-matrix` runs every covering test for every mutant. It reports tests that detect nothing, tests that are subsumed by another test, and tests with duplicate kill sets (#7).
