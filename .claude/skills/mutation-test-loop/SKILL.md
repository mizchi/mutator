---
name: mutation-test-loop
description: Close the test gaps that mutation testing finds in a change, using the mutator CLI. Use when asked to strengthen tests for a branch or PR, to act on mutator's undetected mutants (not detected / not infected / not reached), or to make tests "kill the survivors".
---

# Mutation test loop

mutator reports each mutant the tests miss, together with where the tests stopped short. This skill works through those gaps for the current change: write a test, re-check that mutant, and repeat. The target is detected mutants, not coverage: a test that runs code without asserting anything kills nothing.

## 0. Setup (once per project)

- mutator needs Node.js 24+ and Vitest 5 (or Jest 30 with native ESM). If it is missing, install it: `pnpm add -D @mizchi/mutator`.
- If `.mutator/` is not in `.gitignore`, add it. It holds the cache and the reports. `mutator.accepted.json` at the root is meant to be committed.

## 1. Find the gaps

```sh
mkdir -p .mutator && npx mutator --since <base> --reporter agent > .mutator/agent.json
```

- `<base>` is the branch the change will merge into, usually `main`.
- Read `.mutator/agent.json`. Each entry in `gaps` has:
  - `gap`, the kind of gap
  - the mutant (`original` → `replacement` at `file:line`)
  - the enclosing function as `scope.source`
  - `coveredBy`, up to 10 of the tests that run the mutated code, those naming the function first (`coveredByCount` is the total)
  - `fix`, a generic hint for the kind of gap (the table below says the same)
- Check `warnings` before anything else:
  - `uncollectedTest`: a changed test file is not run, so the gaps it would close are false. Fix the runner config first (include globs, projects, env filters).
  - `skippedTest`: the change adds or edits a skipped or todo test. It checks nothing. Find out why it is skipped. Re-enable it if it passes; otherwise say so to the user rather than deleting it.
- Stop if the run exits 4: the tests fail without any mutant, so fix them first.

## 2. Close each gap

Handle the gaps one function at a time. Read the test files in `coveredBy`, so the new test fits the existing ones: put it in the same file, follow its style, and reuse its helpers.

| `gap` | What to do |
|---|---|
| `notReached` | No test runs this code. Add a test case that reaches it: the branch, the early return or the fallback. |
| `notInfected` | Tests run it, but never with an input where `original` and `replacement` differ. Add an input that separates them. For `>=` → `>`, test the boundary value itself. |
| `notDetected` | Tests run it and the value changes, but nothing fails. Assert on the result that differs: the return value, the thrown error, the state change, the call made. Often this means tightening an existing assertion, for example `toBe` instead of `toBeTruthy`, or an exact `toEqual` instead of a partial match. |

Rules for every test you write:

- **Assert behaviour a caller can observe.** Do not reach into private state, mock the function under test, or assert the exact sequence of internal calls. A test that only pins the implementation kills the mutant but breaks on any refactor.
- **Write a test that fails on the mutated code.** The test name should describe a behaviour, not the mutant.
- **Do not change the code under test** to kill a mutant, unless it has a real bug. If you find one, say so and stop for confirmation.

## 3. Re-check just those mutants

```sh
npx mutator --only <key> --only <key> --reporter agent
# or every gap of the last run:
jq -r '.gaps[].key | "--only=" + .' .mutator/agent.json | xargs npx mutator --reporter agent
```

- `--only` runs only the listed mutants and reuses everything else from the cache, so this takes seconds.
- A mutant that now shows up as `Killed` in `counts` and is gone from `gaps` is done.
- A key that matches no mutant exits 1 with an `unknownKey` warning. The code changed since the key was taken, so run step 1 again.
- If it is still listed, the test does not separate the two versions. Look again at the input or the assertion, instead of adding more tests of the same kind.

## 4. Mutants no test can detect

Some mutants are equivalent: no input can tell the mutated code from the original. Examples are `?.` on a value that is never nullish, a `.sort()` whose order nothing reads, and a guard that a caller already ensures. Do not write a test that asserts implementation details just to kill one of these. Record it instead:

```sh
npx mutator accept <key> --reason "equivalent: <why no input can observe it>"
```

This writes to `mutator.accepted.json`, together with where the mutant is (`file:line:col original -> replacement`). The file is committed and reviewed like code. Later runs list in `acceptance.killed` the accepted mutants that a test detects now, and in `acceptance.stale` the entries whose mutant no longer exists. Remove both kinds from the file. Give a specific reason. If you are not sure the mutant is equivalent, leave it and say so in the summary rather than accepting it.

## 5. Finish

Run step 1 again. Stop when every gap is either:

- killed,
- accepted with a reason, or
- listed for the user as "not sure".

Then report:

- how many gaps were killed, accepted and left
- the tests you added or changed
- the accepted mutants and their reasons
- any real bug you found
