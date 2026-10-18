# Reports

## Statuses

| status | meaning | counted as |
|---|---|---|
| Killed | a covering test failed | detected |
| Timeout | the run ran out of time (re-run once with a longer budget first) or hit the loop guard | detected |
| RuntimeError | the run broke outside any test (a test file failing to load) | detected |
| Survived | the covering tests passed | undetected |
| NoCoverage | no test runs the mutant | undetected |
| CompileError | the mutant does not type-check; not run | excluded |
| Ignored | arid (logging-only), disabled by a comment, accepted, or proven equivalent by types | excluded |
| Pending | not run yet (outside `--since`, over `--time-budget`, sampled out) | excluded |

Score = detected / (detected + undetected). With `--since` it covers the mutants in the diff.

## Undetected groups

| group | means | fix |
|---|---|---|
| not detected | tests run it and the value changes, nothing fails | assert on the result that differs (`toBe` instead of `toBeTruthy`, an exact `toEqual`) |
| not infected | tests run it, never with an input where original and mutant differ | add an input that separates them, e.g. the boundary value for `>=` → `>` |
| not reached | no test runs it | add a test case reaching it |
| possibly reached in a child process | only a process a test spawns (`node src/cli.js`) may run it; not counted by `--fail-on-survived` | test the behaviour in process, or leave it |
| killed before, undetected now (`--since`) | outside the diff, its killing tests are gone | restore or replace the removed test |

## Warnings

- **Test file not collected**: a changed test file the runner does not run (include patterns, projects, env filters). Mutants only it would kill look undetected; fix the runner config first.
- **Skipped test**: the change adds a `skip` / `todo` test, which checks nothing.
- **Child process tests**: tests that run project files in a child process, listed per test file.

## Reporters (`--reporter`, repeatable)

- `text` (default): the summary on stdout.
- `json`: `.mutator/report/mutation.json` in the mutation-testing-elements schema (StrykerJS format); the `id` of a mutant is its key.
- `html`: `.mutator/report/index.html` (the report UI, loaded from unpkg).
- `agent`: JSON on stdout for coding agents (logs on stderr): one record per undetected mutant with `key`, `gap`, location, `original` → `replacement`, the enclosing function's source, covering tests and a `fix` hint, plus `warnings` and `acceptance` (accepted entries that are killed now or stale). `scope` is `diff` when the run is narrowed (`--since`, or `--only`, which also sets `selection: "only"`) and `all` otherwise; `score` and `counts` cover that scope. Pipe it (`| jq`) or redirect it to a file.
- `simplify`: covered survivors that remove code (a statement, a branch, a call): code no test observes the removal of, which may be unnecessary. No effect on the score or the gate.

## Other commands

- `mutator accept <key>... --reason <text>`: record equivalent mutants in `mutator.accepted.json`. Later runs report them `Ignored` and list entries whose mutant is detected now or gone.
- `mutator select-tests --since <ref> [--format files|json]`: from the last run's snapshot, without running anything, rank the tests a change can break (killers of mutants in the changed functions first).
- `--kill-matrix`: tests that detect nothing, tests whose kills another test subsumes, and tests with the same kill set. Treat them as candidates for review: a subsumed test can still pin a behaviour worth keeping.
- `--only <key>`: re-check single mutants in about a second, reusing the cache for the rest.
