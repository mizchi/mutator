# Benchmark: mutator vs StrykerJS

Measured 2026-10-09 on five small-to-medium TypeScript libraries tested with Vitest. The harness that produced every number below is in [`bench/`](../bench).

## Summary

Wall-clock seconds. Each cell is the mean of two runs; both runs are in the per-project tables. Scores are detected / (detected + undetected).

| project | mutants (ours / Stryker) | cold | no change | one edit: ours `--since` / ours full / Stryker `--incremental` | score (ours / Stryker) | score on shared mutants |
|---|---|---|---|---|---|---|
| defu | 107 / 103 | **2.0** / 7.3 | **0.26** / 2.1 | **0.63** / 1.8 / 2.5 | 85.0 / 84.5 | 84.0 / 84.0 (100) |
| scule | 153 / 81 | **2.9** / 6.5 | **0.25** / 2.1 | **0.68** / 1.3 / 2.1 | 86.3 / 92.6 | 92.2 / 92.2 (77) |
| cookie-es | 727 / 725 | **12.2** / 16.7 | **0.28** / 2.2 | **0.71** / 2.5 / 2.6 | 86.9 / 86.9 | 86.3 / 86.3 (672) |
| pathe (no `_glob.ts`) | 547 / 524 | 31.9 → 16.8¹ / **15.2** | **0.30** / 4.2 | **1.0** / 17.6 / 4.3 | 87.8 / 87.0 | 87.4 / 87.0 (500) |
| ufo | 1109 / 1011 | **23.6** / 25.9 | **1.1** / 3.0 | **1.1** / 3.6 / 3.5 | 83.9 / 82.6 | 82.6 / 82.6 (938) |

¹ After the fixes below (static mutants only run the test files that loaded them; stuck workers are terminated), pathe's cold run dropped from 31.9 s to 16.8 s with identical verdicts on all 547 mutants. The full pathe mutate set including `_glob.ts` (1021 mutants) now completes in 89 s (it previously crashed).

- We are faster on no-change reruns (8–14x; ufo shows 3x only because of one 1.86 s outlier) and on `--since` after an edit versus Stryker's `--incremental` (3–4x). Cold runs are faster on four projects. pathe was the exception (about twice Stryker's time); the cause was static mutants running every test file, including the 2.9 s `glob.spec.ts` (fixed, see ¹).
- Verdicts agree on every shared mutant except two in pathe. Stryker reports those two as Survived, but they break the test file while Vitest collects it (see pathe below). In those two cases our result is the correct one.
- **Bug found (fixed):** our tool crashed outright when a mutant made a Vitest worker run out of memory. This is why `pathe/src/_glob.ts` was excluded from the measured set. See [Bugs found](#bugs-found).
- The call graph mode (`--experimental-callgraph`) was run on 17 edits, 12 of them semantics-changing. It never produced a verdict difference. It pruned 0–60 mutants per edit (mean 18), and the time saved was 0–2.5 s.

## Environment

- Apple M3 Pro (12 cores), Node v24.14.1, pnpm 12.8.1, mutator at `5fe80e7`
- Stryker: `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` 10.0.0, `coverageAnalysis: "perTest"`, `plugins: ["@stryker-mutator/vitest-runner"]` (required under pnpm), default concurrency (11 runners)
- mutator: default `-j` (6 Vitest instances)
- Vitest: Stryker 10's vitest-runner is broken with Vitest 5. On ufo it scores 17.8% because `url.ts` gets no kills. So every project gets two clones: `<name>` pins vitest 5.0.3 for mutator, and `<name>-stryker` pins vitest 4.1.5 plus Stryker. Separate clones also keep Stryker's `.stryker-tmp` sandboxes out of the tree our tool scans; Vitest would otherwise run the duplicated tests.
- Machine load: before every timed command, the harness waits until the 1-minute load average is below 3 and no node process is using more than 20% CPU. It also kills orphaned vitest/stryker workers (ppid 1) left by earlier bench runs; none were found in these runs. The machine was not fully idle. Microsoft Defender (≈130% CPU combined) and another user's builds (`skewer build`, `ai-reviewer eval`) came and went, so the harness sometimes waited several minutes. One outlier is visible: ufo's no-change run #1 took 1.86 s against 0.33 s for run #2.

| project | commit | mutated | LOC | tests | benchmark edit |
|---|---|---|---:|---:|---|
| [unjs/defu](https://github.com/unjs/defu) | `82632b6` | `src/**/*.ts` | 197 | 23 | `_defu`: `key.toString()` → `String(key)` (refactor) |
| [unjs/scule](https://github.com/unjs/scule) | `5bc6804` | `src/**/*.ts` | 364 | 63 | `upperFirst`: `str[0]` → `str.charAt(0)` (refactor) |
| [unjs/cookie-es](https://github.com/unjs/cookie-es) | `f89ede8` | `src/**/*.ts` | 952 | 134 | `valueSlice`: `min === max` → `max - min === 0` (refactor) |
| [unjs/pathe](https://github.com/unjs/pathe) | `bc7477a` | `src/{_path,utils,_internal}.ts` | 472 | 467 | `join`: template literal → concatenation (refactor) |
| [unjs/ufo](https://github.com/unjs/ufo) | `f06c800` | `src/**/*.ts` | 1571 | 489 | `withoutBase`: also stop at `#` (semantic) |

Each clone has these setup changes, committed locally so that `git diff HEAD` contains only the edit:

- a standalone `pnpm-workspace.yaml` with `strictDepBuilds: false`
- a `vitest.config.mts` where the project has none. Otherwise Vitest walks up into mutator's own config.
- `packageManager` removed and `@vitest/*` dev dependencies dropped

## Method

Runs for our tool, all with `node packages/cli/src/cli.ts --root <clone> --include <glob> --reporter text --reporter json`:

| run | what it does |
|---|---|
| cold | no `.mutator/` |
| no change | rerun on the cold snapshot |
| edit: full | cold snapshot restored, edit applied |
| edit: `--since HEAD` | cold snapshot restored, edit applied |
| cold `--experimental-callgraph` | needs its own snapshot, because the mode is part of the env hash |
| edit: `--experimental-callgraph` | that snapshot restored, edit applied |

Runs for Stryker, all with `stryker run --incremental`:

| run | what it does |
|---|---|
| cold | no incremental file |
| no change | the cold incremental file restored |
| edit | the cold incremental file restored, edit applied |

Every timed command is run twice. Wall time is measured around the process. "Executed" means different things for the two tools:

- **mutator:** the number of mutants run in that invocation.
- **Stryker:** cold runs count all mutants minus NoCoverage and Ignored. Incremental runs count all mutants minus `N of M mutant result(s) are reused`, because Stryker does not print how many it ran.

Shared mutants are matched on file + start/end position + replacement (`bench/compare.ts`). The matcher ignores two cosmetic differences: our outer parentheses (`(a && b)`), and the trailing block comments Stryker keeps in replacements. Two kinds of difference stay unmatched:

- **Cosmetic:** we report the method-name token where Stryker reports the whole call, and the `?.` token where Stryker reports the whole member expression.
- **Real:** mutator-set differences (see Caveats).

## Per-project results

Statuses: K Killed, T Timeout, RE RuntimeError, S Survived, NC NoCoverage, P Pending (outside `--since`, excluded from the score).

### defu

| scenario | tool | wall s (#1 / #2) | mutants | executed | statuses | score |
|---|---|---|---:|---:|---|---:|
| cold | mutator | 2.03 / 1.97 | 107 | 106 | K84 T7 S15 NC1 | 85.0% |
| cold | Stryker | 10.4 / 4.20 | 103 | 102 | K80 T7 S15 NC1 | 84.5% |
| no change | mutator | 0.26 / 0.25 | 107 | 0 | K84 T7 S15 NC1 | 85.0% |
| no change (`--incremental`) | Stryker | 2.07 / 2.07 | 103 | 0 | K80 T7 S15 NC1 | 84.5% |
| edit: full run | mutator | 1.76 / 1.81 | 107 | 98 | K89 T2 S15 NC1 | 85.0% |
| edit: `--since HEAD` | mutator | 0.63 / 0.63 | 107 | 8 | K16 NC1 P90 | 94.1% |
| cold, `--experimental-callgraph` | mutator | 2.09 / 1.97 | 107 | 106 | K84 T7 S15 NC1 | 85.0% |
| edit: `--experimental-callgraph` | mutator | 1.54 / 1.56 | 107 | 75 | K89 T2 S15 NC1 | 85.0% |
| edit: `--incremental` | Stryker | 2.55 / 2.36 | 103 | 4 | K80 T7 S15 NC1 | 84.5% |

- The full run re-runs 98 of 107 mutants: nearly all of defu is the single function `_defu`, and editing it changes the hash that every result depends on.
- Stryker re-runs only the 4 mutants on the edited line and reuses everything else, including Survived results whose covering code changed.
- 5 mutants move between Timeout and Killed from run to run. `isPlainObject → false` makes `_defu` recurse forever, and the run ends either in a stack overflow (Killed) or in a timeout. Both statuses count as detected.
- `test/utils.test.ts` imports `describe` from `node:test`. Its output leaks into the run, and the process exit code is non-zero after an in-process `runMutation`. `bench/callgraph-experiment.ts` handles this by calling `process.exit(0)`.

### scule

| scenario | tool | wall s (#1 / #2) | mutants | executed | statuses | score |
|---|---|---|---:|---:|---|---:|
| cold | mutator | 2.79 / 3.00 | 153 | 149 | K132 S17 NC4 | 86.3% |
| cold | Stryker | 9.30 / 3.69 | 81 | 80 | K75 S5 NC1 | 92.6% |
| no change | mutator | 0.25 / 0.25 | 153 | 0 | K132 S17 NC4 | 86.3% |
| no change (`--incremental`) | Stryker | 2.11 / 2.12 | 81 | 0 | K75 S5 NC1 | 92.6% |
| edit: full run | mutator | 1.30 / 1.23 | 154 | 51 | K132 S18 NC4 | 85.7% |
| edit: `--since HEAD` | mutator | 0.69 / 0.67 | 154 | 8 | K103 S4 NC4 P43 | 92.8% |
| cold, `--experimental-callgraph` | mutator | 2.73 / 2.75 | 153 | 149 | K132 S17 NC4 | 86.3% |
| edit: `--experimental-callgraph` | mutator | 1.20 / 0.92 | 154 | 28 | K132 S18 NC4 | 85.7% |
| edit: `--incremental` | Stryker | 2.11 / 2.11 | 81 | 1 | K75 S5 NC1 | 92.6% |

Stryker generates only 81 mutants here, against our 153. Its instrumenter treats `TSAsExpression` as a type node and skips the whole subtree, including the runtime operand. `@stryker-mutator/instrumenter/dist/src/util/syntax-helpers.js` lists `TSAsExpression` in `tsTypeAnnotationNodeTypes`. Every scule case function ends in `return (...) as PascalCase<...>`, so Stryker never mutates those bodies. The 12 extra survivors in that code explain the lower score (86.3% vs 92.6%). On the 77 shared mutants the two tools agree exactly.

### cookie-es

| scenario | tool | wall s (#1 / #2) | mutants | executed | statuses | score |
|---|---|---|---:|---:|---|---:|
| cold | mutator | 12.4 / 12.0 | 727 | 724 | K600 T32 S92 NC3 | 86.9% |
| cold | Stryker | 20.3 / 13.1 | 725 | 722 | K598 T32 S92 NC3 | 86.9% |
| no change | mutator | 0.29 / 0.27 | 727 | 0 | K600 T32 S92 NC3 | 86.9% |
| no change (`--incremental`) | Stryker | 2.24 / 2.17 | 725 | 0 | K598 T32 S92 NC3 | 86.9% |
| edit: full run | mutator | 2.52 / 2.56 | 728 | 118 | K600 T32 S93 NC3 | 86.8% |
| edit: `--since HEAD` | mutator | 0.71 / 0.70 | 728 | 6 | K523 T22 S68 NC3 P112 | 88.5% |
| cold, `--experimental-callgraph` | mutator | 11.9 / 12.1 | 727 | 724 | K600 T32 S92 NC3 | 86.9% |
| edit: `--experimental-callgraph` | mutator | 2.23 / 2.25 | 728 | 97 | K600 T32 S93 NC3 | 86.8% |
| edit: `--incremental` | Stryker | 2.53 / 2.61 | 726 | 5 | K598 T32 S93 NC3 | 86.8% |

Unmatched mutants:

- Stryker only: 18 `switch` case mutants (emptying a `case` body). Our ConditionalExpression mutator does not cover `case`.
- Ours only: 13 FnValue mutants, plus 6 mutants that set a ternary test to true/false.
- Everything else is cosmetic.

### pathe

| scenario | tool | wall s (#1 / #2) | mutants | executed | statuses | score |
|---|---|---|---:|---:|---|---:|
| cold | mutator | 31.7 / 32.1 | 547 | 544 | K474 T4 RE2 S64 NC3 | 87.8% |
| cold | Stryker | 19.6 / 10.8 | 524 | 521 | K452 T4 S65 NC3 | 87.0% |
| no change | mutator | 0.30 / 0.29 | 547 | 0 | K474 T4 RE2 S64 NC3 | 87.8% |
| no change (`--incremental`) | Stryker | 4.39 / 4.04 | 524 | 46 | K452 T4 S65 NC3 | 87.0% |
| edit: full run | mutator | 17.5 / 17.7 | 547 | 170 | K474 T4 RE2 S64 NC3 | 87.8% |
| edit: `--since HEAD` | mutator | 1.01 / 0.98 | 547 | 10 | K356 T3 S25 NC3 P160 | 92.8% |
| cold, `--experimental-callgraph` | mutator | 33.9 / 34.1 | 547 | 544 | K474 T4 RE2 S64 NC3 | 87.8% |
| edit: `--experimental-callgraph` | mutator | 15.4 / 15.4 | 547 | 150 | K474 T4 RE2 S64 NC3 | 87.8% |
| edit: `--incremental` | Stryker | 4.15 / 4.42 | 524 | 52 | K452 T4 S65 NC3 | 87.0% |

- `src/_glob.ts` is excluded from the mutate set because our tool crashes on it ([bug 1](#bugs-found)).
- **Cold time.** Here we are about twice as slow as Stryker. `-j 11` was no faster than `-j 6` (informal run under load: 37.7 s vs 38.7 s), so concurrency is not the limit. The per-mutant tests are cheap: `test/glob.spec.ts`, which takes 2.4 s, covers none of these mutants. Not investigated further.
- **Edit runs.** The full run after an edit re-runs 170 mutants (17.6 s), because `join` → `normalize` sits under most tests.
- **Stryker's no-change rerun.** Stryker re-runs 46 mutants even with no change. The incremental differ apparently does not trust results for some tests here.
- **The 2 disagreements are detected by us and Survived in Stryker.** Both mutants make `normalizeAliases` throw while `test/utils.spec.ts` is being collected. `const aliases = normalizeAliases(_aliases)` and `Object.entries(aliases)` run in the `describe` body.
  - `src/utils.ts:17`: the `normalizeAliases` body becomes `{}`.
  - `src/utils.ts:36`: `+` becomes `-`.

  Applying the first mutant by hand makes the file fail with `TypeError: Cannot convert undefined or null to object` and "no tests". So the mutant is detected. Stryker 10's vitest runner does not count collection-time failures as kills.

### ufo

| scenario | tool | wall s (#1 / #2) | mutants | executed | statuses | score |
|---|---|---|---:|---:|---|---:|
| cold | mutator | 24.5 / 22.8 | 1109 | 1046 | K917 T13 S116 NC63 | 83.9% |
| cold | Stryker | 30.3 / 21.5 | 1011 | 947 | K823 T12 S112 NC64 | 82.6% |
| no change | mutator | 1.86 / 0.33 | 1109 | 0 | K917 T13 S116 NC63 | 83.9% |
| no change (`--incremental`) | Stryker | 3.04 / 2.97 | 1011 | 0 | K823 T12 S112 NC64 | 82.6% |
| edit: full run | mutator | 3.85 / 3.29 | 1114 | 48 | K920 T13 S118 NC63 | 83.8% |
| edit: `--since HEAD` | mutator | 1.12 / 1.01 | 1114 | 18 | K910 T13 S98 NC63 P30 | 85.1% |
| cold, `--experimental-callgraph` | mutator | 23.2 / 22.7 | 1109 | 1046 | K917 T13 S116 NC63 | 83.9% |
| edit: `--experimental-callgraph` | mutator | 3.25 / 3.28 | 1114 | 48 | K920 T13 S118 NC63 | 83.8% |
| edit: `--incremental` | Stryker | 3.49 / 3.47 | 1016 | 8 | K826 T12 S114 NC64 | 82.5% |

Mutants only one tool generates:

| ours only | Stryker only |
|---|---|
| 72 FnValue | 18 Regex |
| 41 ternary-test (ConditionalExpression) | 1 CallExpression |
| 7 Regex | |

The rest are cosmetic. The numbers are consistent with the earlier measurement in `docs/design.md`.

## Call graph experiment

`bench/callgraph-experiment.ts` is `scripts/callgraph-experiment.ts` plus the project's mutate globs; the script mutates `src/**`, which on pathe includes `_glob.ts`. pathe was measured with the bench copy. The other four projects mutate `src/**/*.ts` anyway and were measured with `scripts/callgraph-experiment.ts` itself; the harness now always uses the bench copy. For each edit, sound mode and call graph mode each start from their own cold snapshot, then the edit is applied. Mutants that sound mode re-runs but call graph mode reuses are "pruned", and their verdicts are compared. Each edit was checked to keep the project's suite green.

| project | edit | kind | sound: ran / s | callgraph: ran / s | pruned | verdict differs |
|---|---|---|---|---|---:|---:|
| defu | `_defu`: `key.toString()` → `String(key)` | refactor | 97 / 1.5 | 76 / 1.3 | 22 | 0 |
| defu | `_defu`: also skip `prototype` keys | semantic | 102 / 1.6 | 81 / 1.3 | 22 | 0 |
| defu | `defuFn`: `object[key] !== undefined` → `!= null` | semantic | 28 / 0.6 | 11 / 0.3 | 17 | 0 |
| scule | `upperFirst`: `str[0]` → `str.charAt(0)` | refactor | 51 / 1.0 | 28 / 0.6 | 23 | 0 |
| scule | `titleCase`: `via` becomes a lower-case exception (module-level regex) | semantic | 149 / 2.6 | 149 / 2.5 | 0 | 0 |
| scule | `STR_SPLITTERS` gains `" "` (module-level const) | semantic | 150 / 2.5 | 150 / 2.5 | 0 | 0 |
| scule | `isUppercase(char = "")` → `char = "A"` | semantic | 131 / 2.5 | 100 / 1.7 | 31 | 0 |
| cookie-es | `valueSlice`: `min === max` → `max - min === 0` | refactor | 118 / 2.6 | 97 / 2.0 | 21 | 0 |
| cookie-es | `parse`: `len < 2` → `len < 3` (ignores `"a="`) | semantic | 118 / 2.2 | 108 / 2.1 | 10 | 0 |
| cookie-es | `valueSlice`: also trims leading `\n` | semantic | 121 / 2.4 | 100 / 2.0 | 21 | 0 |
| pathe | `join`: template → concatenation | refactor | 171 / 17.6 | 151 / 15.3 | 20 | 0 |
| pathe | `normalizeString`: `res.length > 2` → `> 3` (`a/b/..` becomes `.`) | semantic | 376 / 22.3 | 335 / 19.9 | 41 | 0 |
| pathe | `relative`: drive letters compared case-insensitively | semantic | 86 / 14.1 | 82 / 14.5 | 4 | 0 |
| ufo | `withTrailingSlash`: concatenation → template | refactor | 184 / 7.4 | 124 / 4.9 | 60 | 0 |
| ufo | `withoutBase`: also stop at `#` | semantic | 48 / 3.4 | 48 / 3.6 | 0 | 0 |
| ufo | `isEmptyURL`: `./` counts as empty | semantic | 90 / 4.3 | 74 / 3.9 | 16 | 0 |
| ufo | `isRelative`: also accept `.\` | semantic | 20 / 3.0 | 18 / 2.9 | 2 | 0 |

**No verdict was missed in 17 edits (12 semantic), 310 pruned mutants in total.** That is evidence, not proof. Three things keep the risk low here:

- **Pruning is modest.** Pruning only applies to survivors (and to mutants whose covering tests changed) that are not connected in the graph. In these libraries most survivors sit in functions connected to the edited one.
- **Module-level edits disable pruning.** Edits to module-level constants (the two scule regex/array edits) change every function's dependency hash, so nothing is pruned.
- **No test composed values across functions.** No test in these suites passes one function's output into another unrelated function, which is the case the design notes flag as unsound (`expect(f(g(x)))`).

The time saved by pruning was 0 to 2.5 s per edit. The largest saving was on ufo's widely called `withTrailingSlash`, where the run went from 7.4 s to 4.9 s.

The aborted first defu run did log one status difference: `src/_utils.ts:25 true -> false`, sound = Timeout, call graph = Killed. Both statuses count as detected, and the difference comes from the Timeout/Killed nondeterminism described under defu, not from a missed edge. `bench/callgraph-experiment.ts` now prints detected/undetected flips separately.

## Bugs found

1. **[high, fixed in `d3a8ab8` and `ddb0552`] A mutant that runs a Vitest worker out of memory crashes the whole run.** Root cause: on timeout the session closed Vitest gracefully; a worker stuck in the mutant's loop never answered the stop request, so its thread was never terminated (it also kept burning a core for the rest of the run) and its later exit surfaced as an unhandled `'error'` event. Now the pool is force-closed on timeout and the CLI ignores `Worker exited unexpectedly` while it runs. Original report: With the threads pool, the worker exits with code 1. Vitest emits `Error: Worker exited unexpectedly with exit code 1 during started state` as an unhandled `'error'` event, and the CLI dies with exit 1. It writes no snapshot or report, which loses all progress: pathe died at 934 of 1001 mutants after 110 s. This happens deterministically on `pathe/src/_glob.ts`, also with `-j 1`; there `or()`'s `return false → true` makes the parser loop forever while it accumulates output. Minimal repro: a project with vitest 5.0.3 and these two files.

   ```ts
   // src/fill.ts
   export function fill(n: number): number {
     const step = n > 0 ? 1 : 0;
     const out: number[][] = [];
     for (let i = 0; i < n; i += step) out.push(new Array(100_000).fill(i));
     return out.length;
   }
   // test/fill.test.ts
   import { expect, test } from 'vitest';
   import { fill } from '../src/fill.ts';
   test('fill', () => { expect(fill(3)).toBe(3); });
   ```

   `node packages/cli/src/cli.ts --root <repro>` crashes after about 2 s, at mutant 11 of 14. Expected: the mutant is classified (Timeout, RuntimeError or Killed, the way Stryker would) and the run continues. The pathe log also shows `MaxListenersExceededWarning` (11 SIGINT/SIGTERM/exit listeners) at `-j 6`, which is probably unrelated.
2. **[low, not reproduced] One run was killed by a signal.** ufo's "edit: full run" in the first pass ended with `exit null` after 0.87 s, just after `1114 mutants, 48 to run`, and wrote no output. Six manual reruns of the same scenario all exited 0. The harness did not log the signal at the time; it does now.

## Caveats

- **Variance.** Two runs per measurement is little. Stryker's first cold run is consistently slower than its second (defu 10.4 vs 4.2 s, scule 9.3 vs 3.7 s, pathe 19.6 vs 10.8 s), probably from cold caches. If anything, the means favour Stryker. Sub-second numbers carry roughly 0.1 s of noise. Background load on the machine (see Environment) adds more.
- **Vitest versions differ.** Our tool runs on vitest 5.0.3 and Stryker on vitest 4.1.5. Stryker 10's vitest runner does not work with vitest 5.
- **Mutator sets differ.** We have 18 mutators, including:
  - FnValue (return value by TS return type)
  - ternary-test true/false
  - CallExpression statement removal
  - `for(;;)`
  - arid-node suppression of logging-only code (none triggered in these projects)

  Stryker has its own set, which includes `switch` case removal and a richer Regex mutator. Stryker also skips everything under `as` casts.

  Totals and overall scores are therefore not directly comparable. The "score on shared mutants" column is the apples-to-apples number.
- **"Executed" for Stryker is derived, not printed.** See Method.
- **Incremental semantics differ.** Stryker's `--incremental` reuses every result whose mutant and test files are unchanged. That is why it re-runs only 1–8 mutants after an edit. Our full run re-runs results whose enclosing function or covering tests' code changed (17–170 mutants here), and `--since` restricts the run to the diff.
- **pathe uses a reduced mutate set** because of bug 1.

## Reproducing

```sh
# all projects, all phases (clone + install + verify, ours, Stryker, call graph experiment)
node bench/run.ts bench/projects/*.json
# a subset of phases / one project
node bench/run.ts --phase setup,ours bench/projects/defu.json
node bench/run.ts --phase callgraph --reps 2 bench/projects/ufo.json
# markdown tables from .tmp/bench2/results/*.json
node bench/report.ts
# shared-mutant comparison of two mutation-testing-elements reports
node bench/compare.ts .tmp/bench2/state/ufo/cold-2.mutation.json .tmp/bench2/state/ufo/stryker-cold-2.mutation.json --verbose
```

A project spec (`bench/projects/<name>.json`) contains:

| field | contents |
|---|---|
| `repo`, `commit` | the git URL and the pinned commit |
| `mutate` | globs, passed to `--include` and to Stryker's `mutate` |
| `install` | optional; default `pnpm install --no-frozen-lockfile` |
| `vitestOurs` / `vitestStryker` | optional Vitest versions |
| `edit` | the edit for the timed runs: `{file, from, to, kind, note}`; `from` must occur exactly once |
| `callgraphEdits` | the edits for the call graph experiment |

Setup fails if the suite is red at the pinned commit or with any edit applied.

Everything the harness writes goes under `.tmp/bench2/` (gitignored):

| path | contents |
|---|---|
| `<name>` and `<name>-stryker` | the two clones; `.bench-ready` marks finished setup, delete it to rebuild |
| `logs/<name>/*.log` | the full stdout/stderr of every run |
| `state/<name>/` | cold snapshots and mutation-testing-elements reports |
| `results/<name>.json` | the raw measurements |

A full run of the five projects takes about 1–1.5 h, most of it the load-average waits.

## Large project trial: mizchi/uneffect (2026-10-10)

227 source files (4.3 MB of TypeScript), 141,179 mutants; the "fast" test tier (103 files, 1813 tests, 177 s plain `vitest run`). Vitest 5.0.3 in a local copy, M3 Pro.

| run | before fixes | after fixes |
|---|---:|---:|
| instrument all sources | 4.5 s, 364 MB | — |
| one heavy test file (plain: 72 s) | 155 s | 65 s |
| full dry run (coverage) | 376 s, 6.3 GB, baseline failures | 178 s (= plain), 5.2 GB |
| snapshot | 333 MB | 22.9 MB |
| unchanged re-run | 77–85 s, re-collected 20 files | 8.1 s, 0 files, 1.5 GB |
| PR mode: `--since HEAD~1` from a `HEAD~1` snapshot (4 files changed, 181 mutants in the diff) | 1024 s | 1043 s |

PR-mode breakdown (after fixes): 41/103 test files re-collected; 69 of 181 diff mutants rejected by the type checker (TypeScript 7 native API, 2.7 s); 112 run: Killed 31, Timeout 3, Survived 78. Time is dominated by survivors, which must run all covering tests (median 23 tests in 6 files; the project's tests are heavy), so the tool's own overhead is no longer the bottleneck.

Fixes found by this trial:
- instrumented code with no active mutant ran ~2.2x slower (tests timed out in the baseline): the active key is now read once per module and compared inline; coverage is recorded only in dry runs with typed arrays (`scripts/overhead-bench.ts`: mutant runs 170x → ~1.0x, dry run 160x → 2.8x)
- the project's `node_modules/.bin` was not on PATH when the CLI was started directly
- snapshot rows refer to tables of test ids / files / scopes; the text summary lists at most 20 undetected mutants
- scopes holding only ignored mutants looked changed on every run
- stall timeout (no test progress within 3x the slowest test + 10 s) instead of only the sum of all selected tests
- force-terminating a worker thread stuck in a loop occasionally crashed the process (SIGSEGV); sessions use forked workers by default (~18% slower on ufo's cold run)
- with `--since`, the score covers only mutants inside the diff

### PR-mode options on uneffect (same base snapshot, `--since HEAD~1`, 181 mutants in the diff)

| options | diff mutants run | wall | score (changed code) |
|---|---:|---:|---:|
| none (before weak mutation) | 112 | 1024 s | — |
| weak mutation (default) | 112 | 1056 s | 22.0% |
| + `--mutants-per-line 1` | 23 (139 sampled out) | 403 s | 12.6% |
| + `--time-budget 300` | 23 | 394 s | 13.5% |

- Weak mutation did not remove any of this diff's 112 runs (their covering tests do infect them), but across the whole project it decided ~1,100 covered mutants Survived without running — that pays off in full runs, not in this PR. It also makes the dry run heavier (base snapshot 154 s → 208 s).
- One mutant per line is what makes PR mode practical here: 17 min → under 7 min. The remaining time is the partial dry run (41 of 103 test files re-collected: the change touched top-level code imported widely) plus survivors running all their covering tests.
- The time budget counts from the start of the run (dry run included), and in-flight mutants finish, so a 300 s budget ended at 394 s.
