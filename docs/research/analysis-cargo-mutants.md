# cargo-mutants analysis (HEAD 9b09f6c) — saved subagent report (key points)

## Generation
- syn Visit (src/visit.rs:451-922), span text replacement (mutant.rs:140, span.rs:102), adds a marker comment
- Genre: FnValue / BinaryOperator / UnaryOperator (deletion only) / MatchArm / MatchArmGuard / StructField (mutant.rs:22)
- FnValue: recursively generates values from the return type (syntax only, last path segment) (fnvalue.rs:33-261). No type inference; misses become unviable
- Operators: == ↔ !=, && ↔ ||, < → ==,>,<= / > → ==,<,>= / <= → > / >= → <, + → -,* / -,* → +,/ / / → %,* / % → /,+ / << ↔ >> / & → |,^ ...
  - Intentionally not generated: == → <= (equivalent for unsigned comparisons with 0), |= → ^= (prone to equivalence)
- skip: replacement == original body string (visit.rs:466-482), unsafe, test attr, mutants::skip, new inside impl, impl Default, inside skip_calls (with_capacity), const/static
- match arms are deleted only when a `_` arm exists; arms with guards are not deleted (equivalent to guard=false). struct fields are deleted only when `..base` exists
- ID: "{file}:{line}:{col}: {desc}" → a mutant is treated as different when lines shift (weakness)

## --in-diff (in_diff.rs:93-264)
- Does not call git; parses a diff file with flickzeug. Strips only the `b/` prefix; ignores non-.rs files and /dev/null
- affected lines (new-side line numbers): Insert lines / for Delete, the surrounding lines (lineno-1 and the next new line). Context is not included
  - 1-line insert→[i], 1-line delete→[i-1,i], replace→[i-1,i,i+1]
- binary_search each line of the mutant span in a sorted Vec; selected if any single line hits
- Consistency: compares the diff's new side (Context+Insert) with the actual file; mismatch exits 5 (in_diff.rs:159)
- Empty diff / no targets exits 0. Rename-only has 0 hunks and does nothing (#580)
- Limits: test-only changes are not picked up / FnValue span is the body only, so signature changes are missed / a 1-line change in a function selects all its FnValue mutants but not operator mutants on other lines / path mismatch for crates in subdirectories

## Execution
- 1 mutant: overwrite → cargo build → cargo test → revert (lab.rs:256-326). The build dir is copied into a tempdir (reflink preferred, copy_tree.rs)
- Parallelism: one build dir per worker, queue is Mutex<IntoIter>
- Baseline failure exits 4. timeout = baseline test time ×5 (min 20s, timeouts.rs:56). Kills the process group with killpg
- outcome priority: Unviable (build failure) > Timeout > Caught > Missed (outcome.rs:262). exit: 4 > 3 > 2 > 0, 5=diff mismatch
- shard k/n (slice default / round-robin). --iterate: excludes previously caught/unviable by name match
- Forbids automatic snapshot updates via INSTA_UPDATE=no etc. (cargo.rs:47-53)

## Output
- mutants.out/{mutants.json (all, before start), outcomes.json (incremental), diff/, log/, caught|missed|timeout|unviable.txt, lock.json}
- GitHub annotation: missed only, `::warning file=,line=,col=,endLine=,endCol=` (annotation.rs:52)

## Applying it to JS/TS
- Adopt: TS-type-annotation-based FnValue / skip identical strings / switch default and spread conditions / exclusions such as ==→<= / unary deletion only / diff consistency check + exit code design / baseline + automatic timeout / process group kill / shard / iterate / annotation / forbid snapshot updates
- Replace: tree copy → vite transform hook + mutation switching, test selection via per-test coverage, result cache keyed by position-independent ID (file + qualified fn + genre + occurrence order within function + replacement)
- in-diff improvements: call git internally (merge-base, -M --no-prefix), range intersection, per-function mode (judge by the whole function span to catch signature changes), test change → mutant selection via reverse coverage lookup, cache inheritance via rename map
- Bug candidate: StructField does not go through allows_mutant, so --exclude-re has no effect (visit.rs:953-967)
