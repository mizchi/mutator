# mutator

Diff-driven mutation testing for TypeScript / JavaScript projects tested with Vitest (and, experimentally, Jest in native ESM mode, and browser code driven by Playwright Test through a Vite dev server).

- **oxc-based instrumentation** – all mutants are compiled into the source once (mutation switching) by a pure function; formatting is preserved and a sourcemap is emitted.
- **In-memory** – sources are instrumented by a Vite `transform` hook inside Vitest; no sandbox copy of the project.
- **Per-test coverage** – each mutant only runs the tests that execute it.
- **Result reuse** – mutant identity is position independent (`file + scope path + AST path + mutator + replacement`), and every result is cached with the hash of its enclosing function. Unchanged code with unchanged covering tests is never re-run.
- **`--since <ref>`** – only mutants touched by `git diff <ref>` are executed or decided, and only they are counted, listed, annotated and checked by `--fail-on-survived`. The others needing work stay `Pending`, including those weak mutation would decide without running. A changed test file does not pull in the code it covers, since its survivors predate the change. The exception is a mutant outside the diff that was killed before but whose killing tests are all gone (removed or renamed): it is rechecked and listed apart as "killed before, undetected now". A test edited so that it no longer kills is not noticed; a full run catches it. The mutants in the diff are type-checked on a worker thread while the dry run goes on. A changed test file that the runner does not collect (`*.test.*`, `*.spec.*` or under `__tests__/`) is reported as a warning in the summary, the annotations and the JSON report, since the mutants only it would kill look undetected.

## Install

Requires Node.js 24 or later.

```sh
pnpm add -D @mizchi/mutator
```

## Usage

```sh
npx mutator                # full run, writes .mutator/snapshot.json
npx mutator                # second run reuses unchanged results
npx mutator --since main   # PR mode
npx mutator --root <dir>   # another project directory
```

Options: `--scope node|scope` (diff granularity), `--include/--exclude <glob>`, `--runner vitest|jest|playwright|auto`, `--config <runner config>`, `-j <n>`, `--mutants-per-line <n>`, `--time-budget <seconds>`, `--kill-matrix`, `--full-dry-run`, `--fail-on-survived`, `--threshold-break <n>`, `--no-arid` / `--arid-callee <pattern>`, `--config-file <mutator config>`. Run `mutator --help` for the full list.

`--experimental-callgraph` re-runs, after an edit, only the survivors whose function is connected to the edited code in a static call graph. It is faster on widely used functions but can miss effects that flow through test code; see `docs/design.md`.

Mutants in logging-only code (calls matching `console.*`, `logger.*`, `log.*`, `*.debug`, `*.trace`, `debug`, and blocks / ifs that only log) are reported as `Ignored (arid)` and not run, following Google's arid-node rule. Disable per line with `// mutator-disable-next-line [Mutator]: reason` (StrykerJS `// Stryker disable` comments are honoured too).

An undetected mutant judged equivalent (no input can observe it, e.g. `?.` on a value that is never nullish) can be accepted without touching the source: `mutator accept <key>... --reason <text>` records it in `mutator.accepted.json` at the project root, which is meant to be committed. Keys are the `id`s in `mutation.json`, and GitHub annotations print the command for each mutant. An accepted mutant still runs and keeps its cached verdict, but is reported as `Ignored` (`statusReason: accepted: <reason>`), outside the score and `--fail-on-survived`. Keys do not depend on position, so an entry survives edits that move the code. The summary lists entries whose mutant is detected now or no longer exists, so they can be removed.

### Reports

```sh
npx mutator --reporter text --reporter html --reporter json
```

The text summary lists undetected mutants in three groups. Each group says where the tests stopped short, which calls for a different fix:

- **not detected:** tests run the mutant, but none fails. Strengthen an assertion, or accept it as an equivalent mutant.
- **not infected:** tests run it, but never with a value it changes. Add an input.
- **not reached:** no test runs it. Add a test case.

Tests that run the sources in a child process (`node src/cli.js`, through `node:child_process`) do not see the mutants, which are applied in memory. The dry run records the commands each test starts. When one names a file in the project, the summary prints a warning listing those tests, and the undetected mutants in the files that entry imports go to a fourth group, **possibly reached in a child process**. They are not counted by `--fail-on-survived`. The JSON report gives them a `statusReason` and the agent reporter a `childProcess: true` flag.

See [Code coverage and mutation testing](docs/coverage-and-mutation.md) ([日本語](docs/coverage-and-mutation.ja.md)) for how this relates to code coverage.

`--reporter` is repeatable: `text` (default, summary on stdout), `json`, `html`, `agent` and `simplify` (both below). `json` writes `mutation.json` in the [mutation-testing-elements schema](https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema) (`schemaVersion: "2"`, the format StrykerJS emits), so existing tooling such as the Stryker dashboard can read it. `html` writes `index.html` with that JSON inlined; it loads the `mutation-testing-elements` web component from unpkg (pinned version), so viewing it needs network access. Both go to `--report-dir` (default `<root>/.mutator/report`). Mutants outside `--since` are reported as `Pending`, which the report UI excludes from the score.

### Closing gaps with a coding agent

`--reporter agent` prints JSON on stdout (logs go to stderr): one record per undetected mutant in scope, with its gap, the enclosing function's source, the covering tests and the kind of fix it needs. `--only <key>` (repeatable) runs and reports just those mutants and reuses the cache for the rest, so re-checking a survivor after adding a test takes about a second. The [`mutation-test-loop`](packages/cli/skills/mutation-test-loop/SKILL.md) skill runs the loop with a coding agent: find the gaps with `--since`, write a test per gap, re-check with `--only`, and accept the mutants no input can observe.

#### Agent skills

The packages ship [Agent Skills](https://agentskills.io) under `skills/`, following the [skills-npm](https://github.com/antfu/skills-npm) convention, so they install and update with the package:

| skill | package | for |
|---|---|---|
| `mutator` | `@mizchi/mutator` | setting up and running mutator: runners, config, reports, CI ([SKILL.md](packages/cli/skills/mutator/SKILL.md)) |
| `mutation-test-loop` | `@mizchi/mutator` | closing the gaps of a change: write a test per gap, re-check with `--only`, accept equivalents ([SKILL.md](packages/cli/skills/mutation-test-loop/SKILL.md)) |
| `mutator-playwright` | `@mizchi/mutator-playwright` | E2E setup with Playwright and Vite, and troubleshooting ([SKILL.md](packages/playwright/skills/mutator-playwright/SKILL.md)) |

With skills-npm (or `npx skills experimental_sync`), they are linked into your agent's skills directory on install:

```sh
npm i -D skills-npm && npx skills-npm setup
```

Without it, copy the CLI's skills into the project:

```sh
npx mutator init-skill                # writes .claude/skills/mutator/ and .claude/skills/mutation-test-loop/
npx mutator init-skill --dir <dir>    # writes <dir>/<skill>/
```

Running it again is a no-op when the copies are up to date. It refuses to overwrite a copy that differs from the shipped one (edited locally, or installed by an older mutator), writing nothing, unless you pass `--force`; after upgrading mutator, rerun with `--force` to pick up the new version.

### Code that may be unnecessary

`--reporter simplify` prints a second text report on stdout: code whose removal no test observes. It lists the covered survivors (not `NoCoverage`) of the mutants that remove code rather than change a value, grouped by the enclosing function, with the removed code:

| kind | mutator | removal |
|---|---|---|
| statement removed | `CallExpression` | `cache.clear();` → `;` |
| block emptied | `BlockStatement` | `{ ... }` → `{}` |
| condition always `true` / `false` | `ConditionalExpression` | a guard, a branch, a loop or one operand of `&&` / `\|\|` removed |
| `?.` replaced by `.` | `OptionalChaining` | `a?.b` → `a.b`, `f?.()` → `f()` |
| call dropped | `MethodExpression` (removals only) | `s.trim()` → `s` |

```
may be unnecessary - no test observes the removal of this code (1 candidate in 1 function):
each is also listed as a test gap in the summary; remove the code, or add a test that needs it.

src/label.js  label (lines 1-5)
  3:7  condition always false  name.length === 0
```

Value replacements (`ArrowFunction`, `FnValue`, operators, literals, `MethodExpression` swaps) are left out: a survivor there is a test gap, not code that could go. Accepted, equivalent-by-types and other `Ignored` mutants are left out, and so are mutants possibly reached in a child process. With `--since`, only the reported mutants are listed. A row ending in `(no test reaches it with a value it changes)` is not infected: the tests never make the condition differ, which more often means a missing input than dead code.

The two views overlap on purpose. Each candidate is also a *not detected* or *not infected* gap in the summary, because the run cannot tell "the code is unnecessary" from "no test checks what it does": both look like a survivor. The simplify report only frames the removal-type survivors as a question about the code. Reading them, decide per row: delete the code, add the test that needs it, or accept the mutant when the code is there for something tests do not see (a fast path, input from untyped callers). It does not change the score or the quality gate. The agent reporter marks the same gaps with `simplify: "<kind>"`. On scule and ufo, 8 of 62 candidates were code that could go, 38 were test gaps and 16 were fast paths or defensive code ([benchmark](docs/benchmark.md#simplify-reporter-on-scule-and-ufo-2026-10-16)).

### Selecting the tests a change can break

```sh
npx vitest run $(npx mutator select-tests --since main)
npx mutator select-tests --since main --format json
```

`mutator select-tests` reads the snapshot of the last run and ranks the tests to run first for `git diff <ref>`. It runs nothing, so it takes well under a second. The changed functions are the enclosing scopes of the diff's mutants. They are matched by file and scope id, because an edited function has a new hash. The ranking has three groups:

1. tests that killed mutants in the changed functions, most kills first;
2. other tests that executed those mutants. A changed function the snapshot has no results for, such as a new one, brings the test files importing its file instead;
3. changed test files, and test files importing a changed helper or fixture.

`--format files` (default) prints the unique test files in that order, one per line. `--format json` prints the groups, with each test id, its kill and cover counts, and the reason it was picked. The snapshot records only the first test that killed each mutant, because runs stop at the first failure, so group 1 is a subset of the tests that can detect a break there. Test-name filters (`vitest -t`) are not generated, because a test file changed in the diff may hold tests the snapshot has never seen. Without a snapshot, or with one from another mutator version or environment (lockfile, tsconfig, runner config, Node version, mutation options), the command exits 1 and asks for a `mutator` run first.

### Finding tests that detect nothing or are subsumed (kill matrix)

```sh
npx mutator --kill-matrix
```

A normal run stops each mutant at its first failing test, so `killedBy` names the first killer, not every test that can kill it. `--kill-matrix` runs every covering test for every mutant: no early exit inside a test file, every test file runs, and long runs split across sessions run all their shards. Each Killed result then records all its killing tests and is marked as a full matrix in the snapshot. The text summary adds a section, and the JSON (`killMatrix` in `mutation.json`) and agent reporters carry the full lists:

- **detects nothing**: tests that cover at least one mutant but kill none. They run the code without an assertion mutation can observe.
- **subsumed**: tests whose kill set is a strict subset of another single test's, with that test (largest kill set first).
- **duplicates**: groups of tests with the same kill set.

Only mutants with a full matrix count: Killed results from a matrix run, and survivors (a survivor ran every covering test anyway). Timeouts have no matrix and are excluded, as are mutants that were not run (`--mutants-per-line`, `--time-budget`, `--since`) and kills attributed to a test file that failed to load. The summary says how many mutants were used and how many were excluded.

The mode costs 1.1-2.5x a normal cold run on the benchmark projects (every covering test runs, and many of them fail), so it is meant for occasional runs and combines with `--mutants-per-line` and `--time-budget`. Results stay reusable both ways. A normal run reuses matrix verdicts like any other. A matrix run reuses survivors, timeouts and full matrices whose covering tests are all unchanged, and re-runs kills recorded with early exit. A matrix whose covering tests changed loses its mark, even when a normal run keeps its verdict. A snapshot written by a matrix run also gives `select-tests` every killer instead of the first.

Subsumption is measured on today's mutants, not on future faults. A row of a test table, or a test of another function that shares a helper, is often subsumed while still pinning a behaviour worth keeping. Read the lists as candidates for review, not for deletion. Jest runs the mode too (without `--bail`).

### Thresholds and exit codes

`thresholds: { high: 80, low: 60, break: null }` (StrykerJS semantics, in percent). The text summary labels the score `[high]` (>= high), `[low]` (>= low) or `[danger]`, and the JSON/HTML report uses the same `high`/`low`. When `break` (or `--threshold-break <n>`) is set and the score is below it, the run fails the quality gate.

| code | meaning |
|---|---|
| `0` | ok |
| `1` | invalid options or config file |
| `2` | quality gate failed: score below `thresholds.break`, a survived mutant with `--fail-on-survived`, or an undetected mutant in a critical region |
| `4` | tests fail without mutants (baseline) |

### Critical regions

Some code (authentication, permission checks, money calculations) can reasonably require that every mutant be killed or explicitly accepted. Mark it with globs, relative to the root, in the config (`critical: ['src/auth/**']`, or `--critical <glob>`, repeatable), or put `// mutator-critical` on the line before a function or class declaration:

```ts
// mutator-critical
export function canRefund(user: User, order: Order): boolean {
  // every mutant in here, nested functions included, must be killed or accepted
}
```

The comment marks the first function or class that starts on the next line (a declaration, an arrow function assigned to a variable, a method, or a class); a comment followed by anything else marks nothing.

In a critical region, any undetected mutant (not detected, not infected or not reached) fails the run with exit 2, whatever `thresholds` and `--fail-on-survived` say. Accepted mutants (`mutator accept`) are allowed, and the summary lists them with their reasons. Mutants *possibly reached in a child process* still count: critical code should be tested in process, where mutants are observed. `Pending` (sampled out or over the time budget), `CompileError` and `Ignored` mutants do not count, and with `--since` only the mutants the run reports (in the diff, or rechecked) do. The summary adds a `critical regions:` line with its own score and counts, and lists the undetected critical mutants first, under their own heading. The agent reporter marks their gaps `critical: true`, and `mutation.json` prefixes their `statusReason` with `critical region: must be killed or accepted`.

This is not the same as a global threshold. A project-wide score should not be a KPI, because equivalent mutants cap it below 100%, and raising `thresholds.break` to 100 would force a decision on every equivalent mutant in code nobody worries about. A critical region asks for that decision only where a missed fault is expensive, and an equivalent mutant there is settled once with `mutator accept`, which records the reason for review instead of hiding it in a lower number.

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
  runner: 'auto',                         // 'vitest' | 'jest' | 'playwright' | 'auto'
  vitestConfig: 'vitest.config.ts',
  arid: { callees: ['metrics.*'] },       // or false (= --no-arid)
  experimentalCallgraph: false,
  fullDryRun: false,
  reporters: ['text', 'html'],            // text | json | html | agent | simplify
  reportDir: '.mutator/report',
  thresholds: { high: 80, low: 60, break: 50 },
  failOnSurvived: false,
  typecheck: 'auto',                      // boolean | 'auto'
  mutantsPerLine: 1,                      // default: unlimited
  timeBudget: 600,                        // seconds; default: unlimited
  critical: ['src/auth/**'],              // every mutant here must be killed or accepted
  killMatrix: false,                      // run every covering test per mutant (slower)
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

## Custom mutators (plugins)

Everything works without configuration; plugins only add mutators. A plugin module's default export is a plugin, a mutator, or an array of them:

```ts
// mutators/fallbacks.ts
import { defineMutator, definePlugin } from '@mizchi/mutator';

export default definePlugin({
  name: 'fallbacks',
  mutators: [
    defineMutator({
      name: 'DropFallback',
      // Called for every runtime AST node (oxc ESTree); type positions are never visited.
      visit(node, ctx) {
        if (node.type === 'LogicalExpression' && node.operator === '??') {
          return [{ replacement: ctx.text(node.left) }]; // `a ?? b` -> `a`
        }
      },
    }),
  ],
  aridCallees: ['metrics.*'], // extra logging-like calls to suppress
});
```

```json
{ "plugins": ["./mutators/fallbacks.ts"], "excludedMutators": ["Regex"] }
```

Ignorers (like StrykerJS's) skip whole subtrees: every mutant under a node for which `shouldIgnore` returns a reason is reported as `Ignored` (`<ignorer>: <reason>`) and never run.

```ts
import { defineIgnorer } from '@mizchi/mutator';

export default defineIgnorer({
  name: 'invariant',
  shouldIgnore(node) {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'invariant') {
      return 'assertion helper';
    }
  },
});
```

Plugins may export `ignorers` next to `mutators`. Disable comments take precedence over ignorers, and ignorers over arid suppression.

A mutation replaces the visited node (or a `range` inside it) with text. Placement (mutation switching, parentheses, ASI), identity, disable comments and arid suppression are handled by the engine exactly as for built-in mutators; output that no longer parses is rejected with the mutator's name. Plugins can be relative paths or package names (published plugins must ship JavaScript: Node does not strip types under `node_modules`). Editing a plugin invalidates cached results. CLI: `--plugin <module>`, `--exclude-mutator <name>`.

## Weak mutation

For mutants whose original and mutated expressions are side-effect free (comparisons and arithmetic over identifiers, literals and `.length`, and conditions turned `true` / `false`), the dry run also records which tests reach the mutant with a *different value* (infection). A test that never infects a mutant cannot kill it, so those tests are not run; a covered mutant that no test infects is reported Survived without running at all — typically a boundary (`>=` → `>`) the tests never exercise. Probes re-evaluate only side-effect-free forms, with one known caveat: comparing or adding *objects* calls their `valueOf` / `toString` once more in dry runs. Disable with `--no-weak-mutation` / `weakMutation: false`.

## Type checking

Mutants of TypeScript files are type-checked with the project's own `typescript` before any test runs; those that introduce a new type error in their file become `CompileError`, are not run, and are excluded from the score (like StrykerJS's typescript-checker). The backend follows the installed version:

- TypeScript ≤ 6: the compiler API (LanguageService with in-memory overrides)
- TypeScript ≥ 7: the native API (`typescript/unstable/sync`) with a virtual file system, about 3–7× faster

`typecheck: 'auto'` (default) enables it when `typescript` and `tsconfig.json` are present; `--no-typecheck` / `typecheck: false` disables it. Only the mutated file's diagnostics are compared, so a mutant whose error appears only in other files (e.g. through an inferred return type) is still run and judged by the tests.

The same pass drops mutants the types prove equivalent, on both backends: `a?.b` → `a.b` (and `a?.()` → `a()`, `a?.[k]` → `a[k]`) when the type of `a` excludes `null` and `undefined`. They are reported `Ignored` with `statusReason: equivalent: a is never nullish`, are not run, stay outside the score and `--fail-on-survived`, and the summary counts them (`equivalent by types: N`). This needs both `strictNullChecks` (or `strict`) and `noUncheckedIndexedAccess`: without the latter `xs[0]` is typed `string` but is `undefined` for `[]`, and on ufo all four mutants of that kind were killed. Types can still be wrong (a cast, an `any` assigned to a typed variable, a test passing `undefined as any`, `globalThis.process` in a browser); a dropped mutant is then one a test could have killed. `??` mutants are not dropped: the `??` → `&&` mutant differs whenever the left side is truthy. Only mutants that would otherwise run or be decided by weak mutation are considered; `NoCoverage` ones stay as they are.

## Jest (experimental)

`--runner jest` (or `runner: 'jest'`; `auto`, the default, picks Jest when the root has a `jest.config.*` or a `jest` field in package.json and no Vitest config) runs the same pipeline on a Jest 30 project. Jest is resolved from the project root.

**Supported**

- Native ESM projects only (`"type": "module"`); Jest is run as `node --experimental-vm-modules`. CommonJS is not a target.
- JavaScript, and TypeScript without babel / ts-jest: with `transform: {}` the mutator strips types with Node's built-in `stripTypeScriptTypes` (erasable syntax only; set `extensionsToTreatAsEsm: ['.ts']`). A transformer configured by the project (babel-jest, a custom one, ...) is kept: target files are instrumented first and then handed to it.
- Per-test coverage, static (module-level) mutants, killed / survived verdicts, hit-limit and wall-clock timeouts, `--since`, result reuse, `-j`, `--typecheck`.
- Plugins given as module paths or package names (`plugins` / `--plugin`); the Jest transformer loads them in its own process. Plugin objects passed through the programmatic API are rejected for Jest.
- `--config <file>` / `jestConfig` selects the Jest config.

**How it differs from Vitest**

- Every dry run and every mutant run is a separate Jest process (killed with its process group on timeout). That costs Jest's start-up per mutant (about 0.2–0.3 s on a small project) instead of re-running in a warm in-memory Vite pipeline.
- No dependency tracking of test helpers: editing a helper a test file imports does not re-collect that file's coverage; use `--full-dry-run` after such edits.
- Not supported: Jest `projects`, `test.concurrent` (hits are attributed to whichever test runs), retried tests, JS config files that contain functions (the config is re-serialized as JSON), `.tsx` without a project transformer, Jest's own coverage while mutating.

## Playwright (experimental)

`--runner playwright` mutates browser code that Playwright Test drives end to end, for an app served by a Vite dev server. Mutants are compiled into the served modules once (mutation switching), and the page decides which one is active, so one dev server serves every mutant.

Setup, in the app:

```ts
// vite.config.ts: does nothing unless mutator starts the dev server
import { mutatorVite } from '@mizchi/mutator-playwright/vite';
export default defineConfig({ plugins: [mutatorVite()] });
```

```ts
// in the tests: instead of '@playwright/test' (or `base.extend(mutatorFixtures)`)
import { expect, test } from '@mizchi/mutator-playwright';
```

```sh
pnpm add -D @mizchi/mutator @mizchi/mutator-playwright
npx mutator --runner playwright --include 'src/**/*.ts'
```

An app with a `vite.config.*` makes `auto` pick Vitest, so pass `--runner playwright` (or set `runner` / `playwrightConfig` in the config file).

**How it works**

- mutator starts the config's `webServer` itself, once per run, with the instrumentation enabled, and runs Playwright through a generated config (next to the project's, removed afterwards) that extends the project's without its `webServer`. Nothing must already listen on the server's url.
- The fixture adds an init script to each test's browser context: it activates the mutant and, in the dry run, records which mutants the test reaches. What a page records survives same-origin navigations (through `sessionStorage`), and every page and frame of the context is read when the test ends.
- Every test file is treated as depending on every mutated file, since the browser loads the sources, not the tests.
- Each dry run and mutant run is a `playwright test` process with one worker, `--retries=0`, `--max-failures=1` unless `--kill-matrix`, and mutator's reporter. Tests are selected by `file:line` and, with several projects, `--project` (test ids then start with `[project]`).
- In mutant runs an `expect` waits at most three times as long as the slowest selected test took in the dry run (at least 1 s, never longer than the config's): a mutant that breaks the page would otherwise cost the full expect timeout per assertion.
- Weak mutation, `--since`, result reuse, `-j`, `--kill-matrix` and `--typecheck` work as with Vitest. On the fixture app a mutant run takes about 1–2 s: a killed mutant mostly waits for its failing `expect`, and starting Playwright costs about 0.6 s per run (keeping Playwright's test-server across runs saved only 4%, so every run is a process).

**Not supported (yet)**: dev servers other than Vite, a server not started through `webServer`, Node-side code run by the tests (API tests, component testing), coverage of pages closed before the test ends, and plugin objects (plugin modules reach the dev server; plugin objects cannot).

## CI (pull requests)

The action in this repository runs mutator on the pull request's diff and keeps `.mutator/` in the GitHub Actions cache, so a pull request only runs the mutants its diff can affect:

```yaml
on:
  pull_request:
  push:
    branches: [main]
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - uses: mizchi/mutator@v0
        with:
          args: --time-budget 600 --fail-on-survived
```

| input | default | |
|---|---|---|
| `since` | the pull request's base commit | `--since` ref. Outside pull requests the default is a full run; pass `${{ github.event.before }}` on pushes to run only the pushed commits. |
| `args` | | extra command-line arguments |
| `working-directory` | `.` | project root |
| `cache` | `true` | restore and save `.mutator/` (this ref first, then the base branch) |
| `command` | `node_modules/.bin/mutator`, else `npx @mizchi/mutator@<version>` | how to run the CLI |
| `version` | `latest` | version for the `npx` fallback |

The base commit is fetched when the checkout is shallow. The snapshot is saved even when the run fails the gate, since its verdicts stay valid. Runs on the default branch fill the cache that pull requests restore. Without the action:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0            # --since needs the base commit
- uses: actions/cache@v4
  with:
    path: .mutator
    key: mutator-${{ github.base_ref }}-${{ github.sha }}
    restore-keys: mutator-${{ github.base_ref }}-
- run: npx mutator --since origin/${{ github.base_ref }} --fail-on-survived
```

Snapshots store paths relative to the project root, so a cache restored in another checkout directory is reused. On GitHub Actions, undetected mutants are also printed as `::warning` annotations on the diff, titled by gap (unreached ones only with `--since`).

### Large projects

On a large codebase even the diff can hold more mutants than a PR check can afford (most of the time goes to survivors, which run every covering test). Two options bound the run:

```sh
npx mutator --since origin/main --mutants-per-line 1 --time-budget 600
```

- `--mutants-per-line <n>` runs at most `n` mutants per source line, as in Google's [Practical Mutation Testing at Scale](https://arxiv.org/abs/2102.11378): within a line the most productive mutators win (equality / conditional / arithmetic / logical operators before literals and structural mutators, custom mutators last), ties broken by a hash of the mutant key. The selection is deterministic and independent of the cache, so cached verdicts stay usable across runs.
- `--time-budget <seconds>` stops starting new mutant runs once the budget (measured from the start of the run) is spent; runs already in flight finish. Under a budget, mutants run cheapest first (summed duration of their selected tests), so the budget settles as many mutants as possible.

Mutants left out by either option are reported as `Pending` (excluded from the score, never cached as a verdict) and the text summary says how many, e.g. `not run: 63 sampled out (--mutants-per-line), 12 over the time budget (--time-budget)`. A later run without the options executes them.

### Timeouts

A mutant run that does not finish is reported as `Timeout` (counted as detected). Three limits stop it:

- a hit limit, derived from the dry run's hit counts (100x, at least 10,000): instrumented code that exceeds it throws, which stops loops in the code under test right away;
- a stall timeout: no test starts or finishes within 3x the slowest selected test plus 10 s;
- a total timeout: 1.5x the summed dry-run duration of the selected tests plus 5 s.

The two timeouts are derived from the dry run, so a machine that is busier during the mutant runs (CI neighbours, parallel jobs) can push a correct but slow run past them. A run that ran out of time is therefore re-run once with 3x both budgets, and only a second timeout is reported as `Timeout`. A run stopped by the hit limit has proved a loop and is not re-run. The text summary says how many runs were re-run, e.g. `timeouts re-run with a longer budget: 2 (1 timed out again)`.

A `RuntimeError` (the run failed outside any test: a test file that fails to load, an unhandled error) is re-run once with the same budget, and counts only if it fails that way again. Without it, an error that a flaky test file raises under load is credited as a detection of whatever mutant was running. The summary reports these too: `runtime errors re-run to confirm them: 3 (1 failed again)`.

## Packages

| package | role |
|---|---|
| `@mizchi/mutator-core` | pure library: `instrument`, mutators, identity, diff parsing / selection, reuse planner, the runner `Session` contract. No fs / runner dependency. |
| `@mizchi/mutator-vitest` | Vite plugin + Vitest session (dry run with coverage, run a mutant against selected tests). |
| `@mizchi/mutator-jest` | Jest session (experimental, native ESM): wrapper transformer, setup files, one Jest process per run. |
| `@mizchi/mutator-playwright` | Playwright session (experimental): Vite plugin for the dev server, test fixture for the page, one Playwright process per run. |
| `@mizchi/mutator-typecheck` | type-checks mutants with the project's own TypeScript (compiler API for 6, native API for 7) so that ill-typed ones are reported as `CompileError`, and those the types prove equivalent as `Ignored`, without running. |
| `@mizchi/mutator` | CLI / orchestration: git, snapshot, report. |

## Development

```sh
pnpm install
pkf run check            # typecheck + tests (or: pnpm exec tsc -p . && pnpm exec vitest run)
node scripts/robustness.ts <dir>...   # instrument every file and check the output parses
```

Releasing: set the same version in every `packages/*/package.json`, add its section to `CHANGELOG.md`, and push a `v<version>` tag. The `release` workflow checks that the tag matches the versions, runs the checks, packs with pnpm, publishes the tarballs with npm through trusted publishing (OIDC; each package lists `release.yml` of this repository as its trusted publisher on npmjs.com, no token), creates the GitHub release from the changelog section, and moves the major tag (`v0`) that `uses: mizchi/mutator@v0` follows.

The first version of a package has to be published by hand, because npm adds a trusted publisher only to a package that exists: pack each package with `pnpm pack` (it rewrites `workspace:*`) and run `npm publish <tarball> --access public` in the order core, vitest, jest, typecheck, cli.

Design notes and the survey of StrykerJS / cargo-mutants / PIT live in [`docs/`](./docs).
