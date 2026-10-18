---
name: mutator
description: Set up and run mutator (@mizchi/mutator), diff-driven mutation testing for TypeScript/JavaScript projects tested with Vitest, Jest (native ESM) or Playwright Test. Use when asked to add mutation testing to a project, to run it on a change or in CI, to read its report (killed, survived, not detected / not infected / not reached), or to configure thresholds, critical regions, accepted mutants or the GitHub Action.
license: MIT
compatibility: Node.js 24+, git; Vitest 5, Jest 30 (native ESM) or Playwright Test with a Vite dev server
---

# mutator

mutator changes the code under test one small edit at a time (a *mutant*: `>=` to `>`, a return value to `""`, a call removed) and runs the tests that cover it. A mutant no test fails on is a gap in the tests, whatever the coverage says. Results are cached per function, so after the first run only what a change affects runs again.

To close the gaps it finds (write tests, re-check, accept equivalents), use the `mutation-test-loop` skill. For browser code tested end to end with Playwright, see the `mutator-playwright` skill (in `@mizchi/mutator-playwright`).

## 1. Install

```sh
pnpm add -D @mizchi/mutator    # or npm i -D / yarn add -D
```

- Requires Node.js 24+ and a git repository (`--since` diffs against git).
- Add `.mutator/` to `.gitignore`: it holds the cache (`snapshot.json`) and reports. Commit `mutator.accepted.json` when it appears.

## 2. Pick the runner

`--runner auto` (the default) decides from the config files in the root: a `vitest.config.*` or `vite.config.*` → Vitest, a `jest.config.*` (or a `jest` field) → Jest, a `playwright.config.*` → Playwright. A Vite app with Playwright tests has a `vite.config.*`, so pass `--runner playwright` there. Details per runner: [references/runners.md](references/runners.md).

## 3. First run

```sh
npx mutator                          # whole project; writes .mutator/snapshot.json
npx mutator --since main             # only mutants in `git diff main`
npx mutator --include 'src/core/**'  # a part of the project
```

- What is mutated: `src/**` by default; set `include` / `exclude` (globs, relative to the root) for other layouts.
- Exit code 4 means the tests fail without any mutant: fix them first.
- A large project's first run can take long. Bound it with `--time-budget <seconds>` (unrun mutants stay `Pending` and run next time) or `--mutants-per-line 1`, or start with `--since`.
- Later runs reuse every result whose function and covering tests did not change.

## 4. Read the result

The text summary gives the score (detected / run, in %) and lists undetected mutants by where the tests stopped short:

| group | meaning | fix |
|---|---|---|
| not detected | tests run it, nothing fails | assert on the value that differs |
| not infected | tests run it, never with an input it changes | add an input (a boundary value) |
| not reached | no test runs it | add a test case |
| possibly reached in a child process | only a spawned process may run it | test it in process, or leave it |

The label after the score is `[high]` (at or above `thresholds.high`, default 80), `[low]` (at or above `thresholds.low`, default 60) or `[danger]`. A `Survived` mutant may not have run: weak mutation decides a covered mutant that no test reaches with a different value without running it (it is listed as not infected).

A mutant no input can observe (an *equivalent* mutant, e.g. `?.` on a value that is never nullish) is recorded with `npx mutator accept <key> --reason "..."`. The text summary shows no keys: they are in the `--reporter agent` / `json` output and in the GitHub annotations, so re-run with `--reporter agent` to get them. Statuses, reporters and warnings: [references/reports.md](references/reports.md).

## 5. Configure

Put lasting options in `mutator.config.json` (or `.ts` / `.mjs` with `defineConfig`), with `"$schema": "./node_modules/@mizchi/mutator/schema/mutator.config.schema.json"`. Common keys: `include`, `exclude`, `runner`, `thresholds` (`break` fails the run below a score), `failOnSurvived`, `critical` (globs whose every mutant must be killed or accepted), `timeBudget`. All keys and flags: [references/config.md](references/config.md).

## 6. CI

On pull requests, run on the diff with the cache kept between runs. The repository ships a GitHub Action:

```yaml
- uses: mizchi/mutator@v0
  with:
    args: --time-budget 600
```

Gate with `--fail-on-survived` or `thresholds.break` once the baseline is known. Workflow details and the cache: [references/ci.md](references/ci.md).

## Exit codes

| code | meaning |
|---|---|
| 0 | ok |
| 1 | invalid options or config file, or an `--only` key that matches no mutant |
| 2 | quality gate failed: score below `thresholds.break`, a survivor with `--fail-on-survived`, or an undetected mutant in a critical region |
| 4 | tests fail without mutants |
