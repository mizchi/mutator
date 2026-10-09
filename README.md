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

Options: `--scope node|scope` (diff granularity), `--include/--exclude <glob>`, `--config <vitest config>`, `-j <n>`, `--full-dry-run`, `--fail-on-survived`, `--threshold-break <n>`, `--no-arid` / `--arid-callee <pattern>`, `--config-file <mutator config>`. Run `mutator --help` for the full list.

`--experimental-callgraph` re-runs, after an edit, only the survivors whose function is connected to the edited code in a static call graph. It is faster on widely used functions but can miss effects that flow through test code; see `docs/design.md`.

Mutants in logging-only code (calls matching `console.*`, `logger.*`, `log.*`, `*.debug`, `*.trace`, `debug`, and blocks / ifs that only log) are reported as `Ignored (arid)` and not run, following Google's arid-node rule. Disable per line with `// mutator-disable-next-line [Mutator]: reason` (StrykerJS `// Stryker disable` comments are honoured too).

### Reports

```sh
node packages/cli/src/cli.ts --root <project> --reporter text --reporter html --reporter json
```

`--reporter` is repeatable: `text` (default, summary on stdout), `json` and `html`. `json` writes `mutation.json` in the [mutation-testing-elements schema](https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema) (`schemaVersion: "2"`, the format StrykerJS emits), so existing tooling such as the Stryker dashboard can read it. `html` writes `index.html` with that JSON inlined; it loads the `mutation-testing-elements` web component from unpkg (pinned version), so viewing it needs network access. Both go to `--report-dir` (default `<root>/.mutator/report`). Mutants outside `--since` are reported as `Pending`, which the report UI excludes from the score.

### Thresholds and exit codes

`thresholds: { high: 80, low: 60, break: null }` (StrykerJS semantics, in percent). The text summary labels the score `[high]` (>= high), `[low]` (>= low) or `[danger]`, and the JSON/HTML report uses the same `high`/`low`. When `break` (or `--threshold-break <n>`) is set and the score is below it, the run fails the quality gate.

| code | meaning |
|---|---|
| `0` | ok |
| `1` | invalid options or config file |
| `2` | quality gate failed: score below `thresholds.break`, or a survived mutant with `--fail-on-survived` |
| `4` | tests fail without mutants (baseline) |

### Config file

`mutator.config.ts` (or `.mts`, `.mjs`, `.js`, `.json`) in the project root, or `--config-file <path>` (`--config` is the Vitest config). Fields mirror the CLI flags; precedence is CLI flags > config file > defaults. Paths are relative to the project root. Unknown keys and wrong types are errors (exit 1).

```ts
// mutator.config.ts (Node strips the types; no build step)
import { defineConfig } from '@mizchi/mutator';

export default defineConfig({
  include: ['src/**/*.ts'],
  exclude: ['src/generated/**'],
  scope: 'node',                          // 'node' | 'scope'
  concurrency: 4,
  vitestConfig: 'vitest.config.ts',
  arid: { callees: ['metrics.*'] },       // or false (= --no-arid)
  experimentalCallgraph: false,
  fullDryRun: false,
  reporters: ['text', 'html'],            // text | json | html
  reportDir: '.mutator/report',
  thresholds: { high: 80, low: 60, break: 50 },
  failOnSurvived: false,
  typecheck: 'auto',                      // boolean | 'auto'
});
```

```json
{
  "$schema": "./node_modules/@mizchi/mutator/schema/mutator.config.schema.json",
  "since": "origin/main",
  "thresholds": { "break": 60 }
}
```

Boolean flags accept a `--no-` prefix (`--no-fail-on-survived`) to override a config file value.

## Type checking

Mutants of TypeScript files are type-checked with the project's own `typescript` before any test runs; those that introduce a new type error in their file become `CompileError`, are not run, and are excluded from the score (like StrykerJS's typescript-checker). The backend follows the installed version:

- TypeScript ≤ 6: the compiler API (LanguageService with in-memory overrides)
- TypeScript ≥ 7: the native API (`typescript/unstable/sync`) with a virtual file system, about 3–7× faster

`typecheck: 'auto'` (default) enables it when `typescript` and `tsconfig.json` are present; `--no-typecheck` / `typecheck: false` disables it. Only the mutated file's diagnostics are compared, so a mutant whose error appears only in other files (e.g. through an inferred return type) is still run and judged by the tests.

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
