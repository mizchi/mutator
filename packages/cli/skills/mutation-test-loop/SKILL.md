---
name: mutation-test-loop
description: Close the test gaps that mutation testing finds in a change, using the mutator CLI. Use when asked to strengthen tests for a branch or PR, to act on mutator's undetected mutants (not detected / not infected / not reached), or to make tests "kill the survivors".
---

# Mutation test loop

mutator reports each mutant the tests miss, together with where the tests stopped short. This skill works through those gaps for the current change: write a test, re-check that mutant, and repeat. The target is detected mutants, not coverage: a test that runs code without asserting anything kills nothing.

## 0. Setup (once per project)

To set mutator up from scratch (runner, config file, CI), use the `mutator` skill; this one assumes it runs.

- mutator needs Node.js 24+ and Vitest 5 (or Jest 30 with native ESM, or Bun 1.4+ for `bun test`). If it is missing, install it: `pnpm add -D @mizchi/mutator`.
- If `.mutator/` is not in `.gitignore`, add it. It holds the cache and the reports. `mutator.accepted.json` at the root is meant to be committed.

## 1. Find the gaps

```sh
mkdir -p .mutator && npx mutator --since <base> --reporter agent > .mutator/agent.json
```

- `<base>` is the branch the change will merge into, usually `main`.
- Progress goes to stderr, so the file holds only the JSON. `score` there is a fraction (0.75), not a percentage.
- Read `.mutator/agent.json`. Each entry in `gaps` has:
  - `gap`, the kind of gap
  - the mutant (`original` → `replacement` at `file:line`)
  - the enclosing function as `scope.source`
  - `coveredBy`, up to 10 of the tests that run the mutated code, those naming the function first (`coveredByCount` is the total)
  - `fix`, a generic hint for the kind of gap (the table below says the same)
- Check `warnings` before anything else:
  - `uncollectedTest`: a changed test file is not run, so the gaps it would close are false. Fix the runner config first (include globs, projects, env filters).
  - `skippedTest`: the change adds or edits a skipped or todo test. It checks nothing. Find out why it is skipped. Re-enable it if it passes; otherwise say so to the user rather than deleting it.
  - `childProcessTest`: a test runs the sources in a child process, where mutants are not observed. Gaps with `childProcess: true` may already be covered there: prefer an in-process test of the same behaviour, or leave them.
- Exit codes: 4 means the tests fail without any mutant: stop and fix them first. 2 (the project's quality gate: `thresholds.break`, `--fail-on-survived`, critical regions) is expected while gaps remain; the JSON is complete, carry on.

Then start a ledger, `.mutator/ledger.md`, with one row per gap. Fill in its verdict as you go, so the work survives a context reset or a handoff:

```md
| key | file:line | gap | verdict | test / reason |
|---|---|---|---|---|
| 1yhqbzzp7bx | src/a.ts:12 | notInfected | killed | test/a.test.ts "clamps at the bound" |
```

Use only these verdicts:

- `killed`: a new or changed test detects it (confirmed by the re-check in step 3)
- `accepted`: equivalent, recorded with `mutator accept` (step 4)
- `suspected bug`: the mutant looks more correct than the original; stop and ask
- `could not kill`: two re-checks failed and you do not know why
- `not testable`: observing it needs something the tests cannot reach (timing, a real network, process exit)

## 2. Close each gap

Handle the gaps one function at a time (group them by `scope.id`). Read the test files in `coveredBy`, so the new test fits the existing ones: put it in the same file, follow its style, and reuse its helpers.

| `gap` | What to do |
|---|---|
| `notReached` | No test runs this code. Add a test case that reaches it: the branch, the early return or the fallback. |
| `notInfected` | Tests run it, but never with an input where `original` and `replacement` differ. Add an input that separates them. For `>=` → `>`, test the boundary value itself. (Only Vitest, Bun and Playwright report it, for operator and literal mutants; with Jest, or for other mutants, such a gap is a `notDetected`.) |
| `notDetected` | Tests run it, but nothing fails: either no assertion notices, or (see `notInfected`) no input changes the value; check the input first for a comparison. Assert on the result that differs: the return value, the thrown error, the state change, the call made. Often this means tightening an existing assertion, for example `toBe` instead of `toBeTruthy`, or an exact `toEqual` instead of a partial match. |

Rules for every test you write:

- **Assert behaviour a caller can observe.** Do not reach into private state, mock the function under test, or assert the exact sequence of internal calls. A test that only pins the implementation kills the mutant but breaks on any refactor.
- **Write a test that fails on the mutated code.** The test name should describe a behaviour, not the mutant.
- **Never compute the expected value with the code under test.** `expect(f(x)).toBe(f(x))` style tests, or an expected value copied from running `f`, only pin the current behaviour, bugs included. Derive it from the specification, a hand calculation, or an independent implementation.
- **Do not change the code under test** to kill a mutant, unless it has a real bug. If you find one, say so and stop for confirmation.
- **Never let the code under test decide what a test destroys.** Under a mutant it may return anything: a test that kills the pids or deletes the paths a function returns can kill or delete the wrong ones. Act only on the processes and files the test itself created.

## 3. Re-check just those mutants

```sh
npx mutator --only <key> --only <key> --reporter agent
# or every gap of the last run:
npx mutator --reporter agent $(jq -r '.gaps[].key | "--only=" + .' .mutator/agent.json)
```

- `--only` runs only the listed mutants and reuses everything else from the cache, so this takes seconds.
- A mutant that now shows up as `Killed` in `counts` and is gone from `gaps` is done.
- The score and the quality gate cover only the selected mutants: an exit code 2 here just means some of them are still undetected.
- A key that matches no mutant gives an `unknownKey` warning (and exit 1). The code changed since the key was taken, so run step 1 again. Read `warnings`, not the exit code, when the command runs through `xargs` or a script that changes exit codes.
- If it is still listed, the test does not separate the two versions. Look again at the input or the assertion, instead of adding more tests of the same kind.
- After two re-checks that leave the same mutant listed, stop on it: mark it `could not kill` in the ledger with what you tried, and move on.

## 4. Mutants no test can detect

Some mutants are equivalent: no input can tell the mutated code from the original. Examples are `?.` on a value that is never nullish, a `.sort()` whose order nothing reads, and a guard that a caller already ensures. Do not write a test that asserts implementation details just to kill one of these. Record it instead:

```sh
npx mutator accept <key> --reason "equivalent: <why no input can observe it>"
```

This writes to `mutator.accepted.json`, together with where the mutant is (`file:line:col original -> replacement`). The file is committed and reviewed like code. `accept` does not check that the mutant is undetected: accept only keys from `gaps`. Once the file exists, later runs list in `acceptance.killed` the accepted mutants that a test detects now, and in `acceptance.stale` the entries whose mutant no longer exists. Remove both kinds from the file. A run of some files (`--include`) cannot judge the entries of the other files: while such a file exists, its entries are in neither list, which says nothing about them. Entries of a deleted file, and entries without a `where`, are judged by every run. Give a specific reason. If you are not sure the mutant is equivalent, leave it and say so in the summary rather than accepting it.

## 5. Finish

Run step 1 again (it re-runs the mutants your new tests cover, so it takes longer than the `--only` checks). Reconcile the ledger with that run before you stop: a `killed` mutant that is listed again (a later edit removed what killed it) goes back to open, and a gap the run lists that the ledger lacks gets a row. If closing a gap the final run found changes a test, run step 1 again and reconcile again: stop only after a run that follows every test edit, when every gap it lists has a verdict in the ledger.

Then report, from the ledger:

- how many gaps were killed and accepted, and which are `suspected bug`, `could not kill` or `not testable`
- the tests you added or changed
- the accepted mutants and their reasons
- any real bug you found

`.mutator/` is ignored by Git, so the ledger stays local. Once the report is written, delete `.mutator/ledger.md` only: the rest of `.mutator/` is the cache and the reports.
