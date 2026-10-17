# Changelog

## Unreleased

- The `mutation-test-loop` agent skill ships with `@mizchi/mutator`, and `mutator init-skill [--dir <dir>] [--force]` copies it into the project (default `.claude/skills`). It refuses to overwrite an edited copy unless `--force` (#12).
- The child-process warning lists one line per test file, with the number of its spawning tests and the project files they run, instead of every command (#10).
- Jest runner: a mutant whose failing tests span several test files is now `Killed` with its killing test recorded, instead of `RuntimeError` with none. Jest's `--bail` exited before writing its JSON report; each finished test file is now recorded as it completes. A test file that fails to load is still a `RuntimeError` (#13).
- A mutant run that runs out of time is re-run once with 3x the budget before it is reported as `Timeout`, so a machine that is busier than during the dry run no longer turns slow kills and survivors into timeouts (or drops them from `--kill-matrix`). Runs stopped by the hit limit are not re-run. The summary reports how many runs were re-run (#14).

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
