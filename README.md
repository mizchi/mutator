# mutator

Diff-driven mutation testing for TypeScript / JavaScript projects tested with Vitest (and, experimentally, Jest in native ESM mode).

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

Options: `--scope node|scope` (diff granularity), `--include/--exclude <glob>`, `--runner vitest|jest|auto`, `--config <runner config>`, `-j <n>`, `--mutants-per-line <n>`, `--time-budget <seconds>`, `--full-dry-run`, `--fail-on-survived`, `--threshold-break <n>`, `--no-arid` / `--arid-callee <pattern>`, `--config-file <mutator config>`. Run `mutator --help` for the full list.

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

`--reporter` is repeatable: `text` (default, summary on stdout), `json` and `html`. `json` writes `mutation.json` in the [mutation-testing-elements schema](https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema) (`schemaVersion: "2"`, the format StrykerJS emits), so existing tooling such as the Stryker dashboard can read it. `html` writes `index.html` with that JSON inlined; it loads the `mutation-testing-elements` web component from unpkg (pinned version), so viewing it needs network access. Both go to `--report-dir` (default `<root>/.mutator/report`). Mutants outside `--since` are reported as `Pending`, which the report UI excludes from the score.

### Closing gaps with a coding agent

`--reporter agent` prints JSON on stdout (logs go to stderr): one record per undetected mutant in scope, with its gap, the enclosing function's source, the covering tests and the kind of fix it needs. `--only <key>` (repeatable) runs and reports just those mutants and reuses the cache for the rest, so re-checking a survivor after adding a test takes about a second. The [`mutation-test-loop`](.claude/skills/mutation-test-loop/SKILL.md) skill runs the loop with Claude Code: find the gaps with `--since`, write a test per gap, re-check with `--only`, and accept the mutants no input can observe.

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
  runner: 'auto',                         // 'vitest' | 'jest' | 'auto'
  vitestConfig: 'vitest.config.ts',
  arid: { callees: ['metrics.*'] },       // or false (= --no-arid)
  experimentalCallgraph: false,
  fullDryRun: false,
  reporters: ['text', 'html'],            // text | json | html
  reportDir: '.mutator/report',
  thresholds: { high: 80, low: 60, break: 50 },
  failOnSurvived: false,
  typecheck: 'auto',                      // boolean | 'auto'
  mutantsPerLine: 1,                      // default: unlimited
  timeBudget: 600,                        // seconds; default: unlimited
  critical: ['src/auth/**'],              // every mutant here must be killed or accepted
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

Snapshots store paths relative to the project root, so a cache restored in another checkout directory is reused. On GitHub Actions, undetected mutants are also printed as `::warning` annotations on the diff, titled by gap (unreached ones only with `--since`).

### Large projects

On a large codebase even the diff can hold more mutants than a PR check can afford (most of the time goes to survivors, which run every covering test). Two options bound the run:

```sh
npx mutator --since origin/main --mutants-per-line 1 --time-budget 600
```

- `--mutants-per-line <n>` runs at most `n` mutants per source line, as in Google's [Practical Mutation Testing at Scale](https://arxiv.org/abs/2102.11378): within a line the most productive mutators win (equality / conditional / arithmetic / logical operators before literals and structural mutators, custom mutators last), ties broken by a hash of the mutant key. The selection is deterministic and independent of the cache, so cached verdicts stay usable across runs.
- `--time-budget <seconds>` stops starting new mutant runs once the budget (measured from the start of the run) is spent; runs already in flight finish. Under a budget, mutants run cheapest first (summed duration of their selected tests), so the budget settles as many mutants as possible.

Mutants left out by either option are reported as `Pending` (excluded from the score, never cached as a verdict) and the text summary says how many, e.g. `not run: 63 sampled out (--mutants-per-line), 12 over the time budget (--time-budget)`. A later run without the options executes them.

## Packages

| package | role |
|---|---|
| `@mizchi/mutator-core` | pure library: `instrument`, mutators, identity, diff parsing / selection, reuse planner, the runner `Session` contract. No fs / runner dependency. |
| `@mizchi/mutator-vitest` | Vite plugin + Vitest session (dry run with coverage, run a mutant against selected tests). |
| `@mizchi/mutator-jest` | Jest session (experimental, native ESM): wrapper transformer, setup files, one Jest process per run. |
| `@mizchi/mutator-typecheck` | type-checks mutants with the project's own TypeScript (compiler API for 6, native API for 7) so that ill-typed ones are reported as `CompileError`, and those the types prove equivalent as `Ignored`, without running. |
| `@mizchi/mutator` | CLI / orchestration: git, snapshot, report. |

## Development

```sh
pnpm install
pkf run check            # typecheck + tests (or: pnpm exec tsc -p . && pnpm exec vitest run)
node scripts/robustness.ts <dir>...   # instrument every file and check the output parses
```

Releasing: set the same version in every `packages/*/package.json`, add its section to `CHANGELOG.md`, and push a `v<version>` tag. The `release` workflow checks that the tag matches the versions, runs the checks, packs with pnpm, publishes the tarballs with npm through trusted publishing (OIDC; each package lists `release.yml` of this repository as its trusted publisher on npmjs.com, no token), and creates the GitHub release from the changelog section.

Design notes and the survey of StrykerJS / cargo-mutants / PIT live in [`docs/`](./docs).
