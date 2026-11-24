# Configuration

Options come from `mutator.config.{ts,mts,mjs,js,json}` in the root (or `--config-file <file>`), then the command line, which wins. Boolean flags can be negated to override the file (`--no-fail-on-survived`).

```ts
// mutator.config.ts
import { defineConfig } from '@mizchi/mutator';

export default defineConfig({
  include: ['src/**/*.ts'],
  exclude: ['src/generated/**'],
  thresholds: { high: 80, low: 60, break: 50 },
  critical: ['src/auth/**'],
});
```

```json
{
  "$schema": "./node_modules/@mizchi/mutator/schema/mutator.config.schema.json",
  "include": ["src/**/*.ts"]
}
```

## Keys

| key | flag | what it does |
|---|---|---|
| `include` | `--include <glob>` | sources to mutate (default `src/**/*.{ts,tsx,js,...}`), relative to the root |
| `exclude` | `--exclude <glob>` | sources to skip |
| `since` | `--since <ref>` | only run and report mutants inside `git diff <ref>` |
| `includeTestChanges` | `--include-test-changes` | with `since`, also select mutants covered or imported by changed tests; report detection regressions when a compatible snapshot exists |
| `sharedCache` | `--shared-cache` | reuse snapshots across worktrees via Git's common directory, separated by package, scope and environment |
| `scope` | `--scope node\|scope` | diff granularity: changed nodes (default) or whole enclosing functions |
| `maxWorkers` | `--max-workers <n>` | total active test workers for this invocation, shared across mutant sessions and applied to the baseline |
| `concurrency` | `-j, --concurrency <n>` | parallel test-runner sessions (default: half the CPUs) |
| `shard` | `--shard <index/count>` | CI partition of mutant keys, e.g. `1/4`; independent snapshots and default report directories, scores and gates cover this shard |
| `runner` | `--runner <name>` | `vitest`, `jest`, `bun`, `playwright`; `auto` selects Vitest/Jest/Bun only; set `playwright` explicitly for slower browser E2E mutation runs |
| `vitestConfig` | `--config <file>` | Vitest config file |
| `jestConfig` | `--jest-config <file>` | Jest config file (implies the Jest runner) |
| `bunConfig` | `--bun-config <file>` | bunfig.toml for `bun test` (implies the Bun runner) |
| `playwrightConfig` | `--playwright-config <file>` | Playwright config file; explicitly opts into the slower browser mutation runner |
| `playwrightSourceCoverage` | config only | Experimental Chromium V8 coverage in dry runs, remapped to original function scopes; default false, adds CPU/memory overhead |
| `arid` | `--no-arid`, `--arid-callee <pattern>` | logging-only code is reported `Ignored` and not run (defaults: `console.*`, `logger.*`, `log.*`, `*.debug`, `*.trace`, `debug`); `false` runs it; `{ callees }` and `--arid-callee` replace the defaults, a plugin's `aridCallees` adds to them ([plugins.md](plugins.md)) |
| `experimentalCallgraph` | `--experimental-callgraph` | after edits, re-run only survivors connected to changed code in a static call graph (faster, can miss effects through tests) |
| `fullDryRun` | `--full-dry-run` | collect every test file, bypassing both cached coverage and related-test discovery for a new explicit include scope (also useful after editing a test helper with Jest) |
| `reporters` | `--reporter <name>` | `text` (default), `json`, `html`, `agent`, `simplify`; repeatable |
| `reportDir` | `--report-dir <dir>` | where `json` / `html` go (default `.mutator/report`) |
| `thresholds` | `--threshold-break <n>` | percentages: `high` (default 80) and `low` (default 60, at most `high`) label the score; below `break` (default none) the run exits 2 |
| `failOnSurvived` | `--fail-on-survived` | exit 2 when any mutant survives |
| `typecheck` | `--[no-]typecheck` | type-check mutants with the project's TypeScript first; ill-typed ones are `CompileError` and not run (default `auto`) |
| `weakMutation` | `--no-weak-mutation` | weak mutation decides a covered mutant no test reaches with a different value as Survived without running it (default on) |
| `minimalRelational` | `--minimal-relational` | relational operators get the subsumption-minimal set (`<` -> `<=`, `!=`, `false`); replacements a `.length` / `indexOf` lower bound proves equivalent are skipped (default off) |
| `skipHangs` | `--skip-hangs` | skip mutants that likely hang a loop: a reversed `for` update, an emptied body the loop advances in (default off; heuristic) |
| `skipSubsumed` | `--skip-subsumed` | skip coarse mutants (block, literal, body removals) that have a finer mutant inside them, listed by `mutator skipped` (default off; heuristic) |
| `plugins` | `--plugin <module>` | modules with custom mutators or ignorers (`definePlugin`, `defineMutator`, `defineIgnorer` from `@mizchi/mutator`; see [plugins.md](plugins.md)) |
| `excludedMutators` | `--exclude-mutator <name>` | mutators to skip, built-in or custom |
| `enabledMutators` | `--enable-mutator <name>` | opt-in mutators to run (`ArrayElement`, `ObjectProperty`) |
| `mutantsPerLine` | `--mutants-per-line <n>` | run at most n mutants per line, most productive first; the rest stay `Pending` |
| `timeBudget` | `--time-budget <s>` | after s seconds from the start (dry run included), type-check no further mutant and start no new mutant run; the rest stay `Pending` and run next time. The dry run itself and the in-flight type-check batch and runs are not interrupted |
| `critical` | `--critical <glob>` | every mutant in these files must run and be killed or accepted, otherwise exit 2 (also when `--time-budget` leaves one unrun); also `// mutator-critical` before a function |
| `killMatrix` | `--kill-matrix` | run every covering test per mutant and report tests that kill nothing or are subsumed (slow, occasional) |

Command-line only: `--root <dir>` (project root), `--only <key>` (run and report just this mutant; repeatable), `--config-file <file>`.

## In the source

- `// mutator-disable-next-line: reason` skips the next line; `// mutator-disable-next-line StringLiteral: reason` only that mutator (no brackets). Also `mutator-disable-line`, and `mutator-disable` / `mutator-enable` for a region; StrykerJS `// Stryker disable` comments work too. Details: [plugins.md](plugins.md).
- `// mutator-critical` before a function makes it a critical region.
- `mutator.accepted.json` (written by `mutator accept`) lists accepted equivalent mutants by key, with a reason. Commit it.
