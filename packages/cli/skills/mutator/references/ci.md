# CI

## GitHub Action

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
      - run: npm ci                 # install as the project does (pnpm install --frozen-lockfile, ...)
      - uses: mizchi/mutator@v0
        with:
          args: --time-budget 600
```

| input | default | |
|---|---|---|
| `since` | the pull request's base commit | `--since` ref; outside pull requests a full run. Pass `${{ github.event.before }}` on pushes to run only the pushed commits |
| `args` | | extra arguments, e.g. `--time-budget 600 --fail-on-survived` |
| `working-directory` | `.` | project root |
| `cache` | `true` | restore and save `.mutator/` (this ref first, then the base branch) |
| `command` | `node_modules/.bin/mutator`, else `npx @mizchi/mutator@<version>` | how to run the CLI |
| `version` | `latest` | version for the `npx` fallback |

- The base commit is fetched when the checkout is shallow.
- The snapshot is saved even when the run fails the gate: its verdicts stay valid.
- Runs on the default branch fill the cache that pull requests restore, so a pull request only runs the mutants its diff can affect.
- On GitHub Actions undetected mutants are also printed as `::warning` annotations on the diff, each with the `mutator accept` command for its key (not with `--reporter agent`, whose stdout stays one JSON document). Those in critical regions are `::error` annotations titled `Critical mutant ...`, so the pull request shows which ones fail the check. Set `GITHUB_ACTIONS=true` to see the annotations locally.

## Rolling it out

1. Start with warnings only (no `--fail-on-survived`, no `thresholds.break`) and a `--time-budget`: a few minutes on pull requests (only the diff runs), more on the default branch or a nightly `schedule` run (the action treats it as a push: a full run), which fills the cache and continues a sampled or budgeted rollout.
2. Close or accept the gaps the first pull requests show.
3. Then gate: `--fail-on-survived` on the diff, `thresholds.break` for the score, or `critical` for the code that must be fully tested.

`critical` alone gives "gate the critical code, warn about the rest". It applies on pushes to the default branch too. A critical mutant left unrun by `--time-budget` (or `--mutants-per-line`) also fails the run, so give the budget room for the critical files, or keep their mutants inside it with a warm cache.

## Without the action

For `pull_request` events only (`github.base_ref` is empty on pushes):

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: actions/cache@v4
  with:
    path: .mutator
    key: mutator-${{ github.base_ref }}-${{ github.sha }}
    restore-keys: mutator-${{ github.base_ref }}-
- run: npx mutator --since origin/${{ github.base_ref }} --fail-on-survived
```

Snapshots store paths relative to the root, so a cache restored in another checkout directory is reused.
