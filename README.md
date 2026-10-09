# mutator

Diff-driven mutation testing for TypeScript / JavaScript projects tested with Vitest.

- **oxc-based instrumentation** – all mutants are compiled into the source once (mutation switching) by a pure function; formatting is preserved and a sourcemap is emitted.
- **In-memory** – sources are instrumented by a Vite `transform` hook inside Vitest; no sandbox copy of the project.
- **Per-test coverage** – each mutant only runs the tests that execute it.
- **Result reuse** – mutant identity is position independent (`file + scope path + AST path + mutator + replacement`), and every result is cached with the hash of its enclosing function. Unchanged code with unchanged covering tests is never re-run.
- **`--since <ref>`** – only mutants touched by `git diff <ref>` (and mutants covered by changed test files) are executed.

## Usage

```sh
node packages/cli/src/cli.ts --root <project>               # full run, writes .mutator/snapshot.json
node packages/cli/src/cli.ts --root <project>               # second run reuses unchanged results
node packages/cli/src/cli.ts --root <project> --since main  # PR mode
```

Options: `--scope node|scope` (diff granularity), `--include/--exclude <glob>`, `--config <vitest config>`, `--fail-on-survived`.

### Reports

```sh
node packages/cli/src/cli.ts --root <project> --reporter text --reporter html --reporter json
```

`--reporter` is repeatable: `text` (default, summary on stdout), `json` and `html`. `json` writes `mutation.json` in the [mutation-testing-elements schema](https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema) (`schemaVersion: "2"`, the format StrykerJS emits), so existing tooling such as the Stryker dashboard can read it. `html` writes `index.html` with that JSON inlined; it loads the `mutation-testing-elements` web component from unpkg (pinned version), so viewing it needs network access. Both go to `--report-dir` (default `<root>/.mutator/report`). Mutants outside `--since` are reported as `Pending`, which the report UI excludes from the score.

Exit codes: `0` ok, `2` survived mutants with `--fail-on-survived`, `4` tests fail without mutants.

## Packages

| package | role |
|---|---|
| `@mizchi/mutator-core` | pure library: `instrument`, mutators, identity, diff parsing / selection, reuse planner. No fs / runner dependency. |
| `@mizchi/mutator-vitest` | Vite plugin + Vitest session (dry run with coverage, run a mutant against selected tests). |
| `@mizchi/mutator` | CLI / orchestration: git, snapshot, report. |

## Development

```sh
pnpm install
pkf run check            # typecheck + tests (or: pnpm exec tsc -p . && pnpm exec vitest run)
node scripts/robustness.ts <dir>...   # instrument every file and check the output parses
```

Design notes and the survey of StrykerJS / cargo-mutants / PIT live in [`docs/`](./docs).
