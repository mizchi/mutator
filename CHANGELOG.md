# Changelog

## Unreleased

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

### Reporting

- Undetected mutants are listed in three groups, each with its own fix: not detected, not infected and not reached. See [docs/coverage-and-mutation.md](docs/coverage-and-mutation.md).
- Text summary, GitHub annotations, and the mutation-testing-elements JSON and HTML reporters.
- Config file (`mutator.config.*`), score thresholds, `--fail-on-survived`, and documented exit codes.
