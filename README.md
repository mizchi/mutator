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

Options: `--scope node|scope` (diff granularity), `--include/--exclude <glob>`, `--config <vitest config>`, `-j <n>`, `--full-dry-run`, `--fail-on-survived`, `--no-arid` / `--arid-callee <pattern>`.

Mutants in logging-only code (calls matching `console.*`, `logger.*`, `log.*`, `*.debug`, `*.trace`, `debug`, and blocks / ifs that only log) are reported as `Ignored (arid)` and not run, following Google's arid-node rule. Disable per line with `// mutator-disable-next-line [Mutator]: reason` (StrykerJS `// Stryker disable` comments are honoured too).

Exit codes: `0` ok, `2` survived mutants with `--fail-on-survived`, `4` tests fail without mutants.

## CI (pull requests)

Cache the snapshot per base branch so a PR only runs mutants its diff can affect:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0            # --since needs the merge base
- uses: actions/cache@v4
  with:
    path: .mutator
    key: mutator-${{ github.base_ref }}-${{ github.sha }}
    restore-keys: mutator-${{ github.base_ref }}-
- run: npx mutator --since origin/${{ github.base_ref }} --fail-on-survived
```

Snapshots store paths relative to the project root, so a cache restored in another checkout directory is reused. On GitHub Actions, survived mutants are also printed as `::warning` annotations on the diff.

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
