# mutator

Diff-driven mutation testing for TypeScript / JavaScript projects tested with Vitest (and, experimentally, Jest in native ESM mode, Bun's test runner, and browser code driven by Playwright Test through a Vite dev server).

- **oxc-based instrumentation** – all mutants are compiled into the source once (mutation switching) by a pure function; formatting is preserved and a sourcemap is emitted.
- **In-memory** – sources are instrumented by a Vite `transform` hook inside Vitest; no sandbox copy of the project.
- **Per-test coverage** – each mutant only runs the tests that execute it.
- **Result reuse** – mutant identity is position independent (`file + scope path + AST path + mutator + replacement`), and every result is cached with the hash of its enclosing function. Unchanged code with unchanged covering tests is never re-run.
- **`--since <ref>`** – only mutants touched by `git diff <ref>` are executed or decided, and only they are counted, listed, annotated and checked by `--fail-on-survived`. The others needing work stay `Pending`, including those weak mutation would decide without running. A changed test file does not pull in the code it covers, since its survivors predate the change. The exception is a mutant outside the diff that was killed before but whose killing tests are all gone (removed or renamed): it is rechecked and listed apart as "killed before, undetected now". A test edited so that it no longer kills is not noticed; a full run catches it. The mutants in the diff are type-checked on a worker thread while the dry run goes on. A changed test file that the runner does not collect (`*.test.*`, `*.spec.*` or under `__tests__/`) is reported as a warning in the summary, the annotations and the JSON report, since the mutants only it would kill look undetected.

## Compared with StrykerJS

mutator does what [StrykerJS](https://stryker-mutator.io/) does for JavaScript and TypeScript (mutation switching, per-test coverage, the same report format), built for fast reruns on a changing codebase rather than for breadth of test runners.

### Speed

Five TypeScript libraries tested with Vitest, wall-clock seconds, mean of two runs ([details and method](docs/benchmark.md); StrykerJS 10 with `coverageAnalysis: "perTest"` measured 2026-11-24, mutator at `79f4771` on 2026-11-24, on an Apple M3 Pro):

| project | mutants (mutator / Stryker) | first run | rerun, no change | rerun after a one-line edit (mutator `--since` / Stryker `--incremental`) |
|---|---|---|---|---|
| defu | 107 / 103 | **2.81** / 3.05 | **0.38** / 1.08 | **1.13** / 1.29 |
| scule | 154 / 81 | 4.50 / **2.81** | **0.34** / 1.17 | 1.27 / **1.17** |
| cookie-es | 730 / 725 | 13.0 / **11.9** | **0.34** / 1.43 | **1.11** / 1.64 |
| pathe | 551 / 524 | 15.2 / **9.50** | **0.39** / 2.51 | **1.45** / 2.59 |
| ufo | 1136 / 1011 | 33.9 / **19.7** | **0.42** / 1.80 | **1.86** / 2.03 |

- **Reruns:** 3–6x faster with no change, and up to 1.8x faster after an edit (scule is within 0.1 s). `--since` also reports only the diff, where Stryker reports the whole project.
- **First runs are slower** on four projects (scule, cookie-es, pathe, ufo), up to 1.7x on ufo and pathe. Running the type check alongside execution cut 10–20% from defu, scule, cookie-es and pathe; ufo did not gain. The rest is the fixed cost of each mutant run, a fresh worker per run.
- **Verdicts:** on the mutants both tools generate, they differ on 0–5 per project. The scores on those shared mutants are within 1 point.
- **Versions:** StrykerJS ran on Vitest 4.1.5 (StrykerJS 10's Vitest runner does not work with Vitest 5), mutator on Vitest 5.1.1. Mutator sets differ, so totals and overall scores are not comparable.
- **mootant 0.2.0** is in the same benchmark. It is faster than mutator on cold runs of three projects (defu, cookie-es, ufo) and on `--since`, and generates the fewest mutants. See [the details](docs/benchmark.md#latest-run-2026-11-24-mutator-strykerjs-and-mootant).

Where the speed comes from:

- **No sandbox.** Sources are instrumented in memory by a Vite transform inside warm Vitest instances; StrykerJS by default copies the project into a sandbox and starts its runners for every run.
- **Reuse by function.** A mutant's identity does not depend on its position, and its result is cached with the hash of its enclosing function and its covering tests. A rerun with no change runs nothing; after an edit only the edited functions' mutants run, plus those whose covering tests changed. The coverage run also skips test files the change cannot affect.
- **Diff mode.** `--since <ref>` runs and reports only the mutants in `git diff <ref>`.
- **Fewer runs.** Weak mutation decides covered mutants that no test reaches with a different value as Survived without running them, and mutants that do not type-check are dropped before any test runs (StrykerJS has an optional TypeScript checker for the latter).

### Differences

| | mutator | StrykerJS |
|---|---|---|
| test runners | Vitest 5; Jest 30 in native ESM mode, `bun test` (Bun 1.4+) and Playwright Test for browser code served by Vite (all experimental) | Jest, Vitest, Mocha, Jasmine, Karma, Cucumber, Tap, any command |
| scope of a run | the whole project, or only `git diff <ref>` (`--since`) | `mutate` globs (with line ranges); `--incremental` reuses unchanged results but reports everything |
| undetected mutants | split by where the tests stopped short: not detected, not infected, not reached (with a fix for each) | Survived, NoCoverage |
| equivalent mutants | `mutator accept <key>` (keyed, outside the source, reported when stale) and `?.` proven unneeded by types; disable comments | disable comments (`// Stryker disable`, also honoured by mutator) |
| a test file failing to load under a mutant | detected | Survived (StrykerJS 10's Vitest runner) |
| mutators | 20, including function return values by type, call statement removal, a dropped `await` and a dropped regex flag, plus 2 opt-in (`--enable-mutator`: ArrayElement, ObjectProperty); logging-only code is skipped (arid) | its own set, including `switch` case removal and a richer regex mutator; skips everything under `as` casts |
| beyond the score | critical regions, `--kill-matrix` (redundant tests), `--reporter simplify` (code no test needs), `select-tests` (tests a change can break), `--reporter agent` and agent skills, a GitHub Action with a cached snapshot | Stryker Dashboard, plugins for many runners and checkers |
| reports | mutation-testing-elements JSON and HTML (the format StrykerJS emits), text, GitHub annotations | mutation-testing-elements HTML / JSON, progress, dashboard |
| maturity | 0.x | stable, widely used |

Choose StrykerJS for a test runner mutator does not support (Mocha, Karma, Jasmine, CommonJS Jest), for the Stryker Dashboard, or for a long-established tool. Choose mutator for Vitest projects where mutation testing should run on every change, in CI or by a coding agent.

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
npx mutator --since main --include-test-changes --kill-matrix  # also review changed tests
npx mutator --shared-cache  # reuse validated results across Git worktrees
```

Use `pnpm exec mutator --watch` while editing. The first run starts one second after the watcher is ready. The first edit in each subsequent batch starts a one-second timer, so continuous saves trigger periodic runs. Set the interval in milliseconds, for example `pnpm exec mutator --watch --watch-throttle 5000` for five seconds or `--watch-throttle 0` for immediate scheduling. In a Git repository with a commit, it defaults to `--since HEAD --include-test-changes` so edits to tests also recheck the mutants they cover. Pass `--since main` to watch the branch diff, or `--no-include-test-changes` to keep the usual source-only diff selection. Outside Git or before the first commit, it uses the normal incremental run.

Saves during a run queue one follow-up. It starts when both the current run and the pending timer have finished. A failing baseline or quality gate leaves the watcher running so you can fix the failure and save again. Git-ignored files, dependencies, mutator's cache and generated reports do not trigger reruns. `--watch --reporter agent` emits one compact JSON report per successful analysis. Press Ctrl-C to stop.

`--include-test-changes` extends `--since` to mutants covered by added, edited or removed tests. Tests without reached mutants fall back to the files in their observed import graph. `selectionReasons` in the JSON/agent report records the tests that selected each mutant. A compatible previous snapshot also enables detection-regression warnings: a mutant in unchanged code was Killed before, but is Survived or NoCoverage now. Without that snapshot, `comparison` is `unavailable`; no regression claim is made. The default `--since` continues to report changed code and rechecks for removed killers only.

Cache validation includes enclosing pnpm/npm workspace manifests and lockfiles, stopping at the repository boundary. Each `--include`/`--exclude` scope keeps its snapshot under `.mutator/scopes/`, so alternating between scopes preserves each scope's results. Writing the default include out (for example in a config file) keeps the default scope; any other selection starts cold once, and the run says so. `.mutator/snapshot.json` continues to contain the latest run for existing scripts. `--shared-cache` stores snapshots under Git's common directory, separated by package, scope and environment, so worktrees can reuse them without a copy script. `select-tests` accepts the same flag. Snapshot writes are atomic.

With Vitest and Vite+, the dry run also records what each test file reads while it runs: files and directories inside the project read through `node:fs` / `node:fs/promises` (`readFile`, `readdir`, `opendir`, `stat`, `lstat`, `access`, `exists`, `open` with a read flag, `createReadStream`, sync forms included; outside `node_modules` and `.mutator`), and the environment variables it reads through `process.env` (or `import.meta.env`, which Vitest serves from it). Their content (a file's bytes, a directory's entries with their types, every descendant for `readdir(dir, { recursive: true })`, `node_modules` and `.mutator` left out, or the file's absence) and values join that test file's key, so editing a fixture or changing a variable re-collects the file and re-runs the verdicts its tests covered; a file no test read changes nothing. A test that lists every variable (`Object.keys(process.env)`, a spread, a child process started without `env`) is keyed on the whole environment except variables that differ between shells, terminals or invocations: `_`, `PWD`, `OLDPWD`, `SHLVL`, `COLUMNS`, `LINES`, `WINDOWID`, `TERM_SESSION_ID`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `SECURITYSESSIONID`, `LaunchInstanceID`, `XPC_SERVICE_NAME`, `XPC_FLAGS`, `__CF_USER_TEXT_ENCODING`, `Apple_PubSub_Socket_Render`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `SSH_CLIENT`, `SSH_CONNECTION`, `SSH_TTY`, `TMUX`, `TMUX_PANE`, `npm_command`, `npm_lifecycle_event`, `npm_lifecycle_script`, `npm_execpath`, `npm_node_execpath`, `npm_config_user_agent`, `PNPM_SCRIPT_SRC_DIR`, `VITEST_POOL_ID`, `VITEST_WORKER_ID`, `VITEST_VM_POOL`, and names starting with `ITERM_`, `VSCODE_`, `KITTY_`, `WEZTERM_`, `GHOSTTY_` or `npm_package_` (package.json is already part of the cache key). Other `npm_config_*` variables stay in the key, so running through `pnpm run` and running directly re-collect such a test once. Files changed after the dry run started (written by the tests themselves) are left out; a directory is keyed on its entries after the run. Values come from the environment mutator runs in; reads made by native code or through file descriptors are not tracked.

For Vitest and Vite+, the first run with an explicit `include` uses Vite's import graph to collect coverage only from related test files, including re-exports and literal dynamic imports. Computed imports, CommonJS loading, child processes, workers, unsupported source transforms or an unavailable graph fall back to a full dry run. `--full-dry-run` always collects every test file; runners without dependency discovery keep that behavior too.

Inline Vitest `test.projects` keep their own plugins, environments and setup files. With multiple projects, test IDs include the project name after `#` (for example `test/math.test.ts#[unit] add`), and cached mutant runs retain the owning project. Mutator disables Vitest's filesystem transform cache, including inside these projects, so changing `include` cannot reuse an uninstrumented transform.

Relative paths in test IDs, mutant identities, snapshots and reports use `/` on every operating system, including Windows. Absolute paths passed to filesystem and runner APIs retain their platform's format.

Options: `--scope node|scope` (diff granularity), `--include/--exclude <glob>`, `--runner vitest|jest|bun|playwright|auto`, `--config <runner config>`, `-j <n>`, `--mutants-per-line <n>`, `--time-budget <seconds>`, `--kill-matrix`, `--full-dry-run`, `--fail-on-survived`, `--threshold-break <n>`, `--no-arid` / `--arid-callee <pattern>`, `--config-file <mutator config>`. Run `mutator --help` for the full list.

`--experimental-callgraph` re-runs, after an edit, only the survivors whose function is connected to the edited code in a static call graph. It is faster on widely used functions but can miss effects that flow through test code; see `docs/design.md`.

Mutants in logging-only code (calls matching `console.*`, `logger.*`, `log.*`, `*.debug`, `*.trace`, `debug`, and blocks / ifs that only log) are reported as `Ignored (arid)` and not run, following Google's arid-node rule. Disable per line with `// mutator-disable-next-line [Mutator]: reason` (StrykerJS `// Stryker disable` comments are honoured too).

An undetected mutant judged equivalent (no input can observe it, e.g. `?.` on a value that is never nullish) can be accepted without touching the source: `mutator accept <key>... --reason <text>` records it in `mutator.accepted.json` at the project root, which is meant to be committed. Keys are the `id`s in `mutation.json`, and GitHub annotations print the command for each mutant. An accepted mutant still runs and keeps its cached verdict, but is reported as `Ignored` (`statusReason: accepted: <reason>`), outside the score and `--fail-on-survived`. Keys do not depend on position, so an entry survives edits that move the code. The summary lists entries whose mutant is detected now or no longer exists, so they can be removed. A run of some files (`--include`) leaves the entries of the other files unlisted while those files exist; entries of a deleted file, and entries without a `where`, are judged by every run.

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

`--reporter` is repeatable: `text` (default, summary on stdout), `json`, `html`, `agent` and `simplify` (both below). `json` writes `mutation.json` in the [mutation-testing-elements schema](https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema) (`schemaVersion: "2"`, the format StrykerJS emits), so existing tooling such as the Stryker dashboard can read it. `html` writes `index.html` with that JSON inlined; it loads the `mutation-testing-elements` web component from unpkg (pinned version), so viewing it needs network access. Both go to `--report-dir` (default `<root>/.mutator/report`). With `--since` or `--only`, mutants outside the selection appear as `Pending` and are excluded from the report score and kill matrix. For an out-of-diff recheck, `statusReason` records its verdict and `findings` lists any gap.

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

`mutator select-tests` uses a previous snapshot when available to rank the tests to run first for `git diff <ref>`. It runs nothing, so it takes well under a second. It parses the changed sources to find their enclosing scopes. They are matched by file and scope id, because an edited function has a new hash. For a removed function, the snapshot identifies its former tests. When a module loses a binding, its importing test files are also selected because they may rely on the binding without calling it. For a deleted or renamed file, the command looks up importers of its old path. The ranking has three groups:

1. tests that killed mutants in the changed functions, most kills first;
2. other tests that executed those mutants. A changed function the snapshot has no results for, such as a new one, brings the test files importing its file instead;
3. changed test files, and test files that import a changed helper or fixture, a removed file, or a module that lost a binding. A change to a module containing only re-exports also selects its importers.

`--format files` (default) prints the unique test files in that order, one per line. `--format json` prints the groups, with each test id, its kill and cover counts, and the reason it was picked. The snapshot records only the first test that killed each mutant, because runs stop at the first failure, so group 1 is a subset of the tests that can detect a break there. Test-name filters (`vitest -t`) are not generated, because a test file changed in the diff may hold tests the snapshot has never seen. On a first run it uses static dependencies to select test files. An incompatible existing snapshot still produces a diagnostic so CI can refresh it.

The standalone [@mizchi/test-impact](./packages/test-impact/README.md) package provides a CLI and a Node API for the same cold selection. It can also select individual tests from recorded Chromium coverage without running mutation testing.

### Candidates that were not made mutants

```sh
npx mutator skipped
npx mutator skipped --format json
```

Some candidates are removed before they become mutants, because another mutant already covers them. `mutator skipped` lists each one with the rule that removed it, its category, its own key, and the key of the mutant that justifies it (`by`). `by` is absent for rules without a justifying mutant (`lower-bound`, `loop-advance`, ...) and when the justifying mutant is outside this run (`--since`). It runs no test. The rules so far:

| rule | category | removes |
|---|---|---|
| `same-edit` | duplicate | a second mutator making the same edit as another (for example `FnValue` returning `true` for an arrow whose body a `ConditionalExpression` mutant already replaces with `true`) |
| `redundant-call` | subsumed, heuristic | `call();` -> `;` when another mutant lies inside the call (StrykerJS does the same). The inner mutant must be one that runs: not a coarse one, and in TypeScript an operator, condition or boolean mutant, since a literal or structure change there may not compile. A test could kill the removal and miss the inner mutant; this is rare |
| `solitary` | subsumed, heuristic; only with `--skip-subsumed` (`skipSubsumed: true`) | any other coarse mutant (`BlockStatement`, `ArrayDeclaration`, `ObjectLiteral`, `ArrowFunction`, `FnValue`) with another mutant strictly inside it |
| `lower-bound` | equivalent, heuristic; only with `--minimal-relational` | a comparison replacement that a syntactic lower bound makes equal to the original: `.length` / `.size` >= 0, `split(...).length` >= 1, `indexOf` / `findIndex` / `search` >= -1. Examples: `s.length >= 0` -> `true`, `xs.indexOf(x) > -1` -> `!= -1` |
| `loop-advance`, `loop-body` | timeout, heuristic; only with `--skip-hangs` (`skipHangs: true`) | mutants that likely never let a loop end: reversing a `for` update (`i++` -> `i--`, `i += 2` -> `i -= 2`), and emptying the body a loop advances in (a `while` / `do` body, or a `for` body without an update) |
| `awaited-by-caller` | equivalent, heuristic | dropping `await` in `return await p` (or `async () => await p`) outside a `try` block or a `catch` with `finally`: the caller awaits the same promise, which only settles a tick earlier |
| `single-match` | equivalent, heuristic | removing `g` from a regex that can match only once: anchored at the start or end, without `m` and without a top-level alternative |

`--minimal-relational` (`minimalRelational: true`) mutates `<`, `<=`, `>`, `>=` with the subsumption-minimal set (Kaminski, Ammann and Offutt 2011). `<` becomes `<=`, `!=` and `false` (and `<=` becomes `<`, `==`, `true`), instead of both neighbours and both constants. The default set has 4 replacements per comparison and the minimal set 3, and the tests that kill all three kill the others too.

On the five benchmark projects the minimal set has 1–3% fewer mutants, and no comparison where the default set showed a gap looked fully tested with it. It found 8 new survivors, mostly `<` -> `!=` and `>` -> `!= 1`. On inspection most of them are equivalent: a loop counter that only moves up by one, an index that never goes below 0, or a `split` result held in a variable, none of which the syntactic bounds know. It stays off by default until counters are bounded too.

`--skip-subsumed` is off by default. On the five benchmark projects it removes 13–18% of the mutants. Cold runs got faster: cookie-es 15.7 → 13.5 s, pathe 18.3 → 17.3 s, ufo 33.3 → 25.5 s. Coarse removals are also the mutants most likely to time out: cookie-es had 29 timeouts without it and 20 with it. The cost is survivors that only the coarse mutant showed. Of the 405 mutants it removes across the five projects, 3 survived while every mutant inside them was killed. One example is `{ return "."; } -> {}` in pathe: the tests notice `"."` -> `""`, but not a missing return.

`--skip-hangs` is off by default. On the benchmark projects it removes 18 mutants: 14 of them timed out without it and 4 were killed, so no survivor is hidden. A timeout costs its whole time budget: cookie-es, with 10 removed, ran about 2 s (10%) faster; pathe and ufo, with 3 and 5, within noise.

Skipped candidates are not counted, reported or cached. An inner mutant that is disabled or ignored still justifies the skip, so ignoring code never adds mutants to it. An excluded mutator (`--exclude-mutator`) does not.

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

The matrix also includes an `observations` record for every collected test: `detected`, `noKills`, `notReached` (no viable mutant reached), or `incomplete` (early exit, timeout or pending work prevents a conclusion). A test with incomplete measurements is excluded from no-kill and subsumption claims. In JSON and agent reports, `findings` distinguishes critical errors, ordinary gaps, detection regressions, new tests with no kills, and tests whose detection power was not measured. Findings carry `kind`, `severity` and the mutant key or test id; review warnings do not fail the gate automatically.

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
  runner: 'auto',                         // Vitest/Jest/Bun only; Playwright requires opt-in
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

For optional numeric fault models, create a plugin module:

```ts
// mutators/numeric.ts; enable with --plugin ./mutators/numeric.ts
import { numericMutations } from '@mizchi/mutator';

export default numericMutations({
  rounding: true, // Math.floor / ceil / round / trunc -> each other method
  constants: [{ from: 0.1, to: [0.08] }],
});
```

`MathRounding` and `NumericConstant` are independently enabled by these options and can also be excluded by name. Numeric replacements must be finite and are applied only to configured values, including negative values. They add first-order mutants; statement reordering and simultaneous edits are still outside this model. Compare the reported mutant counts and execution time when enabling a rule. A custom mutator factory that captures configuration in its closure should set the mutator's `cacheKey` to a serialization of that configuration, so changing it invalidates cached results.

A mutation replaces the visited node (or a `range` inside it) with text. Placement (mutation switching, parentheses, ASI), identity, disable comments and arid suppression are handled by the engine exactly as for built-in mutators; output that no longer parses is rejected with the mutator's name. Plugins can be relative paths or package names (published plugins must ship JavaScript: Node does not strip types under `node_modules`). Editing a plugin invalidates cached results. CLI: `--plugin <module>`, `--exclude-mutator <name>`.

## Weak mutation

For mutants whose original and mutated expressions are side-effect free (comparisons and arithmetic over identifiers, literals and `.length`, and conditions turned `true` / `false`), the dry run also records which tests reach the mutant with a *different value* (infection). A test that never infects a mutant cannot kill it, so those tests are not run; a covered mutant that no test infects is reported Survived without running at all — typically a boundary (`>=` → `>`) the tests never exercise. Probes re-evaluate only side-effect-free forms, with one known caveat: comparing or adding *objects* calls their `valueOf` / `toString` once more in dry runs. Disable with `--no-weak-mutation` / `weakMutation: false`.

## Type checking

Mutants of TypeScript files are type-checked with the project's own `typescript` before they run; those that introduce a new type error in their file become `CompileError`, are not run, and are excluded from the score (like StrykerJS's typescript-checker). The backend follows the installed version:

- TypeScript ≤ 6: the compiler API (LanguageService with in-memory overrides)
- TypeScript ≥ 7: the native API (`typescript/unstable/sync`) with a virtual file system, about 3–7× faster
- With the Bun runner, Bun's own checker (`bun check`, Bun 1.4+) finds the type errors instead when it bundles the project's TypeScript major (`bun -p process.versions.typescript`, 7 for Bun 1.4). Each mutated text is checked in memory as a sibling of its file that nothing imports, so one `Bun.build({ check: true })` checks up to 200 mutants. A file in an import cycle (type-only imports included, from `bun check --explainFiles`) would be seen unmutated through the cycle, so its mutants are checked one by one at its own path instead, at about 30–60 ms each. On a Bun project of 141 source files it checked 10,757 mutants in 9 s, with the same verdicts as the native API there (96 s). Equivalences (below) still come from the project's TypeScript.
- No `typescript` installed: Bun's checker alone, with any runner, when `bun` is available. It proves no equivalences.

With `typecheck: 'auto'`, no `--time-budget` and no Bun checker, the check runs on a worker thread alongside mutant execution instead of before it. Mutants are checked in batches of 25, in the order they start running, and each mutant waits only for its own batch. The check is faster per mutant than a run, so it stays ahead and a mutant that does not compile is still never run. On ufo (864 runs, 1046 mutants checked) this took the cold run from 34 s to 29 s. `--since` keeps the check that starts alongside the dry run, and `--time-budget` the check-first order it needs to stop on time.

`typecheck: 'auto'` (default) enables it when `tsconfig.json` and one of those checkers are present, and otherwise prints `typecheck skipped: …` with the reason; `--no-typecheck` / `typecheck: false` disables it. Only the mutated file's diagnostics are compared, so a mutant whose error appears only in other files (e.g. through an inferred return type) is still run and judged by the tests.

Type verdicts, including CompileError and equivalence decisions, are cached with the source and the compiler's observed files, configurations and resolution directories. Changes to imported declarations, previously missing imports or discovered source files invalidate this cache. Unchanged reruns can reuse type verdicts without starting the checker.

The same pass drops mutants the types prove equivalent, on both TypeScript backends, also when Bun's checker finds the type errors (not with Bun's checker alone): `a?.b` → `a.b` (and `a?.()` → `a()`, `a?.[k]` → `a[k]`) when the type of `a` excludes `null` and `undefined`. They are reported `Ignored` with `statusReason: equivalent: a is never nullish`, are not run, stay outside the score and `--fail-on-survived`, and the summary counts them (`equivalent by types: N`). This needs both `strictNullChecks` (or `strict`) and `noUncheckedIndexedAccess`: without the latter `xs[0]` is typed `string` but is `undefined` for `[]`, and on ufo all four mutants of that kind were killed. Types can still be wrong (a cast, an `any` assigned to a typed variable, a test passing `undefined as any`, `globalThis.process` in a browser); a dropped mutant is then one a test could have killed. `??` mutants are not dropped: the `??` → `&&` mutant differs whenever the left side is truthy. Mutants that would otherwise run or be decided by weak mutation are considered, and so are `NoCoverage` ones in scope: a mutant no test reaches but that does not compile is a `CompileError`, not a gap to close.

## Vite+ (vite-plus)

A [Vite+](https://viteplus.dev/guide/test) project uses the Vitest adapter. Its `vite.config.ts` (`defineConfig` from `vite-plus`) makes `auto` pick Vitest, and so does an installed `vite-plus` when there is no config file. Run `mutator` as usual; no separate runner option or direct `vitest` dependency is needed.

The adapter resolves `vite-plus/test/node` from the project before `vitest/node`, matching `vp test`'s precedence. Its injected setup uses `vite-plus/test`, so it shares the project's runtime even when another Vitest version is installed. Test configuration stays in `vite.config.ts`, and tests can import from `vite-plus/test`. Persistent module caching is disabled for mutation sessions so every session collects its own mutants. Integration tests cover vite-plus 1.7.0 (Vitest 5.1.0) alongside standalone Vitest 5.1.0.

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

## Bun (experimental)

`--runner bun` (or `runner: 'bun'`; `auto` picks Bun's test runner for a Bun project, one with a `bunfig.toml`, `bun.lock` or `bun.lockb` and neither a Vitest nor a Jest config or installation) runs the same pipeline with `bun test`. mutator itself runs on Node.js and starts `bun` from PATH (a `bun` devDependency works, as `node_modules/.bin` is on PATH).

For an ESM project with application code in `src/` and tests in `test/`, put these files in the project root and run `pnpm exec mutator`.

```ts
// mutator.config.ts
import { defineConfig } from '@mizchi/mutator';

export default defineConfig({
  runner: 'bun',
  include: ['src/**/*.ts'],
  bunConfig: 'bunfig.toml',
});
```

```toml
# bunfig.toml
[test]
root = "./test"
```

Use the `[test]` table shown above for discovery settings. In 0.5.0 the adapter can overlook the equivalent inline table `test = { root = "./test" }` and list tests outside that directory.

**Supported**

- Bun 1.4 or later (`bun test --isolate` is required), ESM JavaScript and TypeScript sources. Test files can import from `bun:test` (or from `vitest` / `@jest/globals`, which Bun maps to it).
- Per-test coverage, weak mutation, static (module-level) mutants, killed / survived verdicts, hit-limit and wall-clock timeouts, `--since`, result reuse (test helpers included: editing one re-collects the test files that loaded it), `-j`, `--typecheck`, `--kill-matrix`, child-process detection (`node:child_process` and `Bun.spawn`).
- Plugins as module paths or as objects: the sources are instrumented in the CLI process.
- `--bun-config <file>` / `bunConfig` selects the bunfig.toml (implies `--runner bun`). Its `[test] root`, `pathIgnorePatterns` and preload files are taken into account.

**How it works**

- The sources are instrumented once, in the CLI process. Every dry run and every mutant run is a separate `bun test --isolate` process with a preload that serves the instrumented sources through a runtime plugin, installs the mutant switch and attributes hits to the running test. Bun starts in milliseconds, so a mutant run of a small project takes a few tens of milliseconds.
- `--isolate` gives each test file a fresh global and module registry, so static mutants are attributed to every file that loads them. Dry runs use `--parallel` (up to `--max-workers` processes); mutants run in one process, killed with its process group on timeout.
- Bun's hooks receive no test context: tests are numbered in the order they start and paired with the tests of Bun's JUnit report, which lists them in declaration order. `test.concurrent`, retried tests or a count that does not match fall back to crediting the file's hits to each of its tests, which costs runs but not verdicts.

**Not supported**

- CommonJS sources: Bun treats a runtime plugin's output as ESM, so tests of an instrumented CommonJS module fail in the baseline. Exclude them.
- Sources imported by a bunfig.toml preload: those preloads run before mutator's, so the modules they load are not mutated.
- `*_test.*` and `*_spec.*` files, which `bun test` collects, are tests and are excluded from the sources to mutate.

## Playwright (experimental)

Playwright Test support mutates browser code in an app served by a Vite dev server. It is **opt-in**: the default `runner: 'auto'` selects Vitest or Jest, and never starts Playwright just because `playwright.config.*` or `@playwright/test` is present. Enable it explicitly in `mutator.config.ts` as shown below.

> **Runtime warning:** Browser E2E mutation testing can take much longer than unit mutation testing. Each mutant run starts a separate Playwright Test process and executes the selected browser tests; browser startup and failing assertion waits add up. A large run can take many minutes or hours. Start with a small `include`, `--since`, sampling and a time budget. Estimates and ETA appear after the baseline and type checking; a time budget stops new runs, while in-flight runs finish.

**Runnable example:** The [Playwright source-coverage sample](examples/playwright-source-coverage/README.md) includes a Vite app, two browser E2Es, complete configuration and a verification script. It checks source correspondence (including functions without mutants), cache reuse, test selection after an edit, and agreement between incremental and cold mutation results.

From a checkout of this repository:

```sh
pnpm install --frozen-lockfile
pnpm --dir examples/playwright-source-coverage exec playwright install chromium
pnpm --dir examples/playwright-source-coverage run verify
```

Verification uses a disposable copy and a free port, and saves its results and logs. The sample also provides `just verify` from its directory.

Install the adapter alongside the app's existing Vite and Playwright Test setup:

```sh
pnpm add -D @mizchi/mutator @mizchi/mutator-playwright
pnpm exec playwright install chromium
```

Add the plugin to the app's Vite config. It does nothing unless mutator starts the dev server:

```ts
// vite.config.ts
import { defineConfig } from 'vite'; // use 'vite-plus' in a Vite+ project
import { mutatorVite } from '@mizchi/mutator-playwright/vite';

export default defineConfig({ plugins: [mutatorVite()] });
```

Configure Playwright to start that dev server through `webServer`, and keep browser tests in a separate directory:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium' },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
```

For Vite+, use `pnpm exec vp dev --host 127.0.0.1 --port 4173 --strictPort` as the server command. Stop any dev server already using that URL before a mutation run. Keep the unit runner's include/exclude patterns from collecting `e2e/**` as unit tests (for example, set Vitest's `test.include` to `['test/**/*.test.ts']`).

Use the adapter's fixtures in the browser tests. Projects with custom fixtures can use `base.extend(mutatorFixtures)` instead:

```ts
// e2e/counter.spec.ts (adapt the selectors and assertions to your app)
import { expect, test } from '@mizchi/mutator-playwright';

test('increments the counter', async ({ page }) => {
  await page.goto('/');
  await page.locator('#count').click();
  await expect(page.locator('#count')).toHaveText('1');
});
```

Enable browser mutation testing explicitly:

```ts
// mutator.config.ts
import { defineConfig } from '@mizchi/mutator';

export default defineConfig({
  runner: 'playwright',
  playwrightConfig: 'playwright.config.ts',
  include: ['src/**/*.ts'],
  concurrency: 2,
  mutantsPerLine: 1,
  timeBudget: 300, // seconds; already-running tests may finish after the budget
});
```

```sh
pnpm exec playwright test          # establish a passing E2E baseline first
pnpm exec mutator                  # uses the explicit Playwright configuration above
pnpm exec mutator --since main     # later runs can focus on changed code
```

Sampling and the time budget leave unrun mutants `Pending`; raise or remove those limits for a full run. Increase concurrency only when the machine can afford more browsers. For a one-off explicit run, `--runner playwright` or `--playwright-config <file>` also enables the adapter. Without an explicit selection, browser mutation tests are never launched automatically.

**How it works**

- mutator starts the config's `webServer` itself, once per run, with the instrumentation enabled, and runs Playwright through a generated config (next to the project's, removed afterwards) that extends the project's without its `webServer`. Nothing must already listen on the server's url.
- The fixture adds an init script to each test's browser context: it activates the mutant and, in the dry run, records which mutants the test reaches. What a page records survives same-origin navigations (through `sessionStorage`), and every page and frame of the context is read when the test ends.
- Every test file is treated as depending on every mutated file, since the browser loads the sources, not the tests.
- Each dry run and mutant run is a `playwright test` process with `--retries=0` and mutator's reporter. By default dry runs use the project's workers and mutant runs use one worker and `--max-failures=1` unless `--kill-matrix`. Tests are selected by `file:line` and, with several projects, `--project` (test ids then start with `[project]`).
- In mutant runs an `expect` waits at most three times as long as the slowest selected test took in the dry run (at least 1 s, never longer than the config's): a mutant that breaks the page would otherwise cost the full expect timeout per assertion.
- Weak mutation, `--since`, result reuse, `-j`, `--kill-matrix` and `--typecheck` work as with Vitest. On the fixture app a mutant run takes about 1–2 s: a killed mutant mostly waits for its failing `expect`, and starting Playwright costs about 0.6 s per run (keeping Playwright's test-server across runs saved only 4%, so every run is a process).

**Optional source coverage (experimental, Chromium only)**

To discover which E2E executes each original source function, including functions with no mutation candidates, enable an additional dry-run collector:

```ts
// mutator.config.ts
import { defineConfig } from '@mizchi/mutator';

export default defineConfig({
  runner: 'playwright',
  playwrightSourceCoverage: true, // default false; additional CPU and memory cost
  include: ['src/**/*.ts', 'src/**/*.tsx'],
});
```

This uses Chromium's V8 execution ranges and the served modules' inline source maps with `sourcesContent`. Only sources in `include` are indexed, and their mapped content must match the files on disk. The snapshot's `sourceCoverage` maps `relative/file.ts#functionScopeId` to test ids; the existing `scopes` table stores source scope hashes. Partial dry runs replace the re-collected tests' observations and retain the others. `select-tests --since` and incremental dry-run planning can use these observations even when a function has no mutants. Changes also invalidate mutation verdicts from affected tests. The index records execution, not assertion quality.

This option adds collection and remapping work to **dry runs only**; mutant runs keep their existing probes. It requires Chromium projects. Multiple navigations can lose V8 coverage; popups, closed pages, frames, workers, missing maps and stale maps are also treated conservatively. Such tests appear in `sourceCoverageIncomplete` and remain candidates for affected sources. Unknown scopes and top-level dependencies keep the existing broad fallback. Source coverage never replaces the exact mutant probes or turns missing observations into a `NoCoverage` verdict.

See the [Playwright coverage benchmark](docs/playwright-coverage-benchmark.md) for measured overhead and commands to reproduce it.

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
      - uses: mizchi/mutator@v0.5.4
        with:
          version: '0.5.4'
          args: --time-budget 600 --fail-on-survived
```

| input | default | |
|---|---|---|
| `since` | the pull request's base commit | `--since` ref. Outside pull requests the default is a full run; pass `${{ github.event.before }}` on pushes to run only the pushed commits. |
| `args` | | extra command-line arguments |
| `shard` | | one-based `INDEX/COUNT`, e.g. `${{ matrix.shard }}/4`; passes `--shard` and isolates the Actions cache |
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

Use `--max-workers` to budget active test workers for one mutator invocation. Use `-j` (`--concurrency`) to limit how many mutant sessions can run at the same time. Both accept positive integers and work with `--watch`.

```sh
pnpm exec mutator --max-workers 8 -j 2
pnpm exec mutator --runner playwright --watch --max-workers 2
```

In the first example the baseline can use eight workers. With enough work for two Vitest or Playwright sessions, each gets up to four workers. With one session, it can use all eight. Mutator splits any remainder across sessions and starts at most one session per available worker. Jest uses the budget during the baseline and runs each mutant in band.

The explicit budget overrides the runner's top-level worker setting for this invocation. It counts test workers across sessions. Browser subprocesses, dev servers and the type checker run separately. Each CI shard has its own budget. Without `--max-workers`, the baseline uses the project's settings and parallel mutant sessions use one worker each.

After the baseline and type checking, mutator prints an approximate time for the remaining mutant execution. It uses previous timings where available, otherwise selected test durations plus file-loading overhead observed in the dry run, divided by the parallel sessions. When the estimate reaches 10 seconds or there are at least 100 mutants to run, an interactive terminal shows a progress bar with the completed count, elapsed time and ETA. Redirected stderr keeps line-by-line output and a heartbeat every 15 seconds. The ETA adapts to measured mutant timings; early kills, retries, module loading and CPU contention can change it. Discovery, the baseline and type checking have already finished when this estimate appears.

**Resuming an interrupted run.** Run the same command again after Ctrl-C or a terminated process. Each completed mutant verdict is committed to a `.resume.sqlite` file beside the scoped snapshot before its progress is displayed. The next run checks the baseline and type information, reports how many verdicts it restored, and runs the remaining mutants. A mutant still executing at interruption is retried. Changing a target source, a tracked test or dependency, or the execution settings can require fresh verdicts. Once the final snapshot is saved, the CLI removes its verdicts from the checkpoint.

Split mutant execution across CI jobs with `--shard INDEX/COUNT` (one-based):

```sh
pnpm exec mutator --shard 1/4 -j 2
```

Mutant keys are assigned by a stable hash, independently of test timings, execution order and cached results. Every mutant belongs to exactly one shard. All shards must use the same commit, options and shard count. `--since`, `--only`, `--mutants-per-line`, `--time-budget` and `--kill-matrix` still apply; sampling is computed before sharding. Each shard collects its baseline and type-checks only its assigned mutants. Its default snapshots and reports are separate (`.mutator/scopes/*-shard-1-of-4.json` and `.mutator/report/shard-1-of-4/`), and it does not overwrite the unsharded snapshot. Give each shard a different path if you override report or snapshot paths.

Scores, thresholds and kill-matrix statistics cover each shard separately; `--fail-on-survived` and critical-region gates compose across the jobs. This does not produce a merged global score. Use a matrix with `fail-fast: false` so every shard can finish and upload its report. With the repository action, use the `shard` input to separate the Actions cache too:

```yaml
jobs:
  mutation:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    env:
      CI: true
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      # Install @mizchi/mutator 0.5.0 or later in the project.
      - uses: mizchi/mutator@v0.5.4
        with:
          version: '0.5.4'
          shard: ${{ matrix.shard }}/4
          args: --reporter text --reporter json --fail-on-survived
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        if: ${{ !cancelled() }}
        with:
          name: mutation-shard-${{ matrix.shard }}
          path: .mutator/report/shard-${{ matrix.shard }}-of-4/
          include-hidden-files: true
```

On a large codebase even the diff can hold more mutants than a PR check can afford (most of the time goes to survivors, which run every covering test). Two options bound the run:

```sh
npx mutator --since origin/main --mutants-per-line 1 --time-budget 600
```

- `--mutants-per-line <n>` runs at most `n` mutants per source line, as in Google's [Practical Mutation Testing at Scale](https://arxiv.org/abs/2102.11378): within a line the most productive mutators win (equality / conditional / arithmetic / logical operators before literals and structural mutators, custom mutators last), ties broken by a hash of the mutant key. The selection is deterministic and independent of the cache, so cached verdicts stay usable across runs.
- `--time-budget <seconds>` stops type-checking mutants and starting new mutant runs once the budget (measured from the start of the run, dry run included) is spent; the dry run is not interrupted, and the type-check batch and runs already in flight finish. Mutants are type-checked in batches before they run, so on a project where type checking is slow the budget can run out before any mutant runs; the type-check verdicts reached so far are cached, so the next run continues from there. A long run split by test file also gets no further parts after that, and its mutant stays `Pending` unless a part that finished already decided it, so the overrun is at most one part. Under a budget, mutants run cheapest first (summed duration of their selected tests), so the budget settles as many mutants as possible.

Mutants left out by either option are reported as `Pending` (excluded from the score, never cached as a verdict) and the text summary says how many, e.g. `not run: 63 sampled out (--mutants-per-line), 12 over the time budget (--time-budget)`. A later run without the options executes them.

### Timeouts

A mutant run that does not finish is reported as `Timeout` (counted as detected). Three limits stop it:

- a hit limit, derived from the dry run's hit counts (100x, at least 10,000): instrumented code that exceeds it throws, which stops loops in the code under test right away;
- a stall timeout: no test starts or finishes within 3x the slowest selected test plus 10 s;
- a total timeout: 1.5x the summed dry-run duration of the selected tests plus 5 s.

The two timeouts are derived from the dry run, so a machine that is busier during the mutant runs (CI neighbours, parallel jobs) can push a correct but slow run past them. A run that ran out of time is therefore re-run once with 3x both budgets, and only a second timeout is reported as `Timeout`. A run stopped by the hit limit has proved a loop and is not re-run. The text summary says how many runs were re-run, e.g. `timeouts re-run with a longer budget: 2 (1 timed out again)`.

A `RuntimeError` (the run failed outside any test: a test file that fails to load, an unhandled error) is re-run once with the same budget, and counts only if it fails that way again. Without it, an error that a flaky test file raises under load is credited as a detection of whatever mutant was running. The summary reports these too: `runtime errors re-run to confirm them: 3 (1 failed again)`.

On POSIX, stopping a run with Ctrl-C (SIGINT) or SIGTERM (a cancelled CI job) kills every process it started (test workers, Jest, Bun and Playwright processes, dev servers) and exits with 130 / 143: a worker stuck in a mutant's loop cannot notice its parent going away, and would otherwise keep spinning. SIGKILL cannot be handled: a worker stuck in a loop then outlives mutator, and the next run in the project stops it. Each run records the processes it starts under `.mutator/processes/`; a later run kills those whose run is gone, that are still orphaned and that started when recorded, so another project's processes or a reused pid are never touched. This orphan reaping uses POSIX process information and is unavailable on Windows.

## Packages

| package | role |
|---|---|
| `@mizchi/test-impact` | Standalone CLI and Node API for selecting affected tests from source dependencies and per-test Chromium coverage. |
| `@mizchi/mutator-core` | pure library: `instrument`, mutators, identity, diff parsing / selection, reuse planner, the runner `Session` contract. No fs / runner dependency. |
| `@mizchi/mutator-vitest` | Vite plugin + Vitest session (dry run with coverage, run a mutant against selected tests). |
| `@mizchi/mutator-jest` | Jest session (experimental, native ESM): wrapper transformer, setup files, one Jest process per run. |
| `@mizchi/mutator-bun` | Bun session (experimental): sources instrumented in the CLI process, a preload serving them to `bun test --isolate`, one Bun process per run. |
| `@mizchi/mutator-playwright` | Playwright session (experimental): Vite plugin for the dev server, test fixture for the page, one Playwright process per run. |
| `@mizchi/mutator-typecheck` | type-checks mutants with the project's own TypeScript (compiler API for 6, native API for 7), or Bun's checker without it, so that ill-typed ones are reported as `CompileError`, and those the types prove equivalent as `Ignored`, without running. |
| `@mizchi/mutator` | CLI / orchestration: git, snapshot, report. |

## Development

```sh
pnpm install
pkf run check            # typecheck + tests (or: pnpm exec tsc -p . && pnpm exec vitest run)
pnpm run pack-smoke      # install the packed packages and test all runtime adapters
node scripts/robustness.ts <dir>...   # instrument every file and check the output parses
```

Releasing: set the same version in every `packages/*/package.json`, add its section to `CHANGELOG.md`, and push a new `v<version>` tag. All tags are immutable, including existing major-version tags such as `v0`. If a release fails or needs a fix, use a new version and tag instead of moving or recreating the existing tag. Pin the GitHub Action to a full version, such as `uses: mizchi/mutator@v0.5.4`, and update the reference explicitly when upgrading.

The `release` workflow runs only for newly created tags. Before publishing, it uses the same Linux and Windows verification as pull requests: type checking, the full test suite and packed CLI smoke tests for Vitest, Vite+, Jest, Bun and Playwright. Windows also runs focused native-path regressions before the smoke tests. POSIX signal and orphan-reaping tests run on Linux. The packed projects live outside the workspace in paths containing spaces, and every adapter must detect mutants.

Both operating systems must pass before the Linux publish job checks the tag against the package versions, packs with pnpm, publishes the tarballs with npm through trusted publishing (OIDC; each package lists `release.yml` of this repository as its trusted publisher on npmjs.com, no token), and creates the GitHub release from the changelog section.

The first version of a package has to be published by hand, because npm adds a trusted publisher only to a package that exists: pack each package with `pnpm pack` (it rewrites `workspace:*`) and run `npm publish <tarball> --access public` in the order core, vitest, jest, bun, typecheck, cli.

Design notes and the survey of StrykerJS / cargo-mutants / PIT live in [`docs/`](./docs).

### Try jev-lint on this repository

With `OPENROUTER_API_KEY` set, run the free Decider trial from the repository root:

```sh
npx -y jev-lint --no-config --model openrouter:perplexity/pplx-decider-v1.3:free
```

After confirmation, jev-lint uses up to 64 tracked filenames to suggest rules, prints the starter YAML, then lints up to three files (32 KiB total). For ongoing reviews and CI, we strongly recommend Jev with `TYPESAFE_API_KEY`, since the rule thresholds are calibrated on Jev. For mutator’s test-selection rules, see the [test-impact review guide](./tools/jev-lint/README.md).
