# Code coverage and mutation testing

[日本語](coverage-and-mutation.ja.md)

Code coverage and mutation testing do not measure the same thing at two strengths. Each measures a different stage of the path a fault must take before a test catches it. Averaging the two numbers mixes different denominators and means nothing. Read them as stages of one funnel.

## The path from fault to failure (RIPR)

A test detects a fault only when all four happen:

| stage | question | measured by |
|---|---|---|
| **R**each | Does a test execute the faulty code? | code coverage; NoCoverage |
| **I**nfect | When executed, does the fault change a value or state? | weak mutation (the dry run records it) |
| **P**ropagate | Does that change reach something the test can observe? | mutation testing |
| **R**eveal | Does an assertion check that observation? | mutation testing (Killed vs Survived) |

Code coverage stops at the first stage. A line counts as covered once any test runs it, with or without an assertion. Mutation testing checks all four, but reports only the end result: Killed or Survived. So 100% coverage can still detect nothing. An example from our trials: [defu's "only merge plain objects"](benchmark.md#survivor-usefulness-on-the-five-small-projects-2026-10-12) added two tests, but left both as `it.skip`. Even when re-enabled, they compared with `toEqual`, which cannot tell a class instance from a plain object.

## Splitting the score instead of mixing it

Count in mutants rather than lines, and the mutation score factors into two parts:

```
mutation score = reach × strength
               = (mutants some test executes / all mutants) × (killed / mutants some test executes)
```

- **Reach** is code coverage weighted by the number of ways the code can be broken. A line with five mutants counts five times.
- **Strength** is what coverage cannot see: among the code the tests do run, the share of faults they actually catch. StrykerJS reports it as "mutation score based on covered code".

Report the two separately. Low reach means test cases are missing. Low strength means the inputs or assertions are weak. One blended number hides which of the two it is.

## Three kinds of gap, three fixes

For each undetected mutant, mutator reports where the tests stopped short:

| gap | the tests… | fix | examples from our trials |
|---|---|---|---|
| **not detected** | run it, but none fails | strengthen an assertion (or accept an equivalent mutant) | defu asserts with `toEqual` where identity matters; ufo never checks `withBase` with the base followed by `?` |
| **not infected** | run it, but never with a value it changes | add an input: a boundary value, another case | pathe's drive-letter check is never tried with `a:` or `z:`; a `>=` → `>` boundary no test touches |
| **not reached** | never run it | add a test case | scule's `{ normalize: true }` branch; uneffect's parse-error early return |

The text summary lists the three groups under separate headings. GitHub annotations carry them as titles: "Mutant not detected", "Mutant not infected", "Mutant not reached". The JSON report keeps the standard statuses (`Survived`, `NoCoverage`) and sets `statusReason` on not-infected mutants. Not-reached mutants are annotated only with `--since`: over a whole project they would bury the rest.

Infection is known only for side-effect-free expressions: comparisons and arithmetic over identifiers, literals and `.length`, and conditions turned `true` / `false` (see [Weak mutation](../README.md#weak-mutation)). Every other surviving mutant is reported as *not detected* even if no test infected it. For example, a removed statement whose effect no test reaches lands here too. So "not infected" is a certainty, and "not detected" is the default.

Some mutants cannot be detected by any test, because no input can observe the difference. These are equivalent mutants: a `?.` on a value that is never nullish, a `.sort()` whose order nothing reads, a disabled fast path in a performance change. They appear as *not detected*. A mutation score of 100% is therefore not reachable in general. Do not make it a target.

## How to use each

1. **Use code coverage as a map of the whole project.** It is cheap, and it shows where there are no tests at all. As a target it is easy to game: executing code without asserting anything raises it.
2. **Use mutation testing as a check on a change.** Run it with `--since` in pull requests, and read the three groups as review comments. In our trials, the survivors on changed lines were real test gaps 77% of the time on five small libraries, and 36% on a large analyser with many report strings and redundant guards ([benchmark](benchmark.md#are-the-survivors-worth-acting-on-10-past-commits-2026-10-11)). Over a whole project, the older survivors outnumber the new ones, and a full run costs much more.
3. **Treat the score as a work list, not a KPI.** Equivalent mutants cap it below 100%. Chasing the last points produces tests that assert implementation details.
4. **Read not-reached mutants on changed lines as coverage at a finer grain.** They overlap with code coverage, but in a diff they name the exact branch or sub-expression no test runs, such as the `: []` fallback of a conditional.

## Pitfalls seen in practice

- **The runner's test set is part of the result.** A test file that the runner does not collect cannot kill anything. Examples are a CI tier that leaves out integration tests, or an `include` glob that misses it. In one trial, 18 of 32 "survivors" were killed by the commit's own test, which the selected tier excluded.
- **Tests that spawn a child process** to run the sources do not see mutants that mutator applies in memory. Mutants covered only that way look not reached.
- **A line that the commit touched is not necessarily code the commit changed.** A mutant on an old guard can show up in a pull request because the commit edited the same line.
