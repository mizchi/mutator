# @mizchi/test-impact

Select tests affected by edits to TypeScript or JavaScript, without executing application code. Requires Node.js 24 or later. The package includes the TypeScript resolver. Vitest, Playwright and mutator are optional consumers.

```sh
pnpm exec test-impact --since HEAD
pnpm exec test-impact --since main --format json
```

The CLI compares the working tree with the merge base of the revision and HEAD, including untracked files. It discovers `*.spec.*`, `*.test.*` and scripts under `__tests__`. Pass repeated `--test <root-relative-file>` arguments for a custom runner inventory. Deleted files and project configuration changes broaden selection. Empty output means no candidate files.

## Node API

```ts
import { selectAffectedTests } from '@mizchi/test-impact';

const result = await selectAffectedTests({
  root: process.cwd(),
  changes: { 'src/price.ts': [12, 13] },
  testFiles: ['test/checkout.spec.ts', 'test/search.spec.ts'],
});
console.log(result.files, result.matches, result.typecheckFiles);
```

Supply either `since` or `changes`. Paths are root-relative with forward slashes. The API normalizes path segments across changes, test inventories and observations, so `./src/price.ts` and `src/price.ts` select the same tests. Line numbers refer to the current source and start at 1. Use `null` for a whole-file change. The result contains runnable test files, matches with selection reasons, and test entries affected through runtime or type-only imports for type checking. Static selection follows module imports, re-exports and literal dynamic imports using the nearest project tsconfig. Unresolved and computed imports broaden selection. Runner setup, bundler plugins and application-specific resource loading can introduce dependencies outside this static graph.

## Per-test Chromium coverage

For a normal Playwright run, create a mapper for the instrument-free served sources and start the collector before exercising the page. The collector uses Chromium JS coverage and inline source maps with matching original content.

```ts
import { createSourceCoverageMapper, startChromiumCoverage } from '@mizchi/test-impact/playwright';

const map = createSourceCoverageMapper({ root, targets: absoluteSourceFiles });
const collector = await startChromiumCoverage(context, page, map);
try {
  await exercisePage(page);
} finally {
  observations[testFile][testId] = await collector.finish();
}
```

To cancel a capture, call `await collector.dispose()` before starting the next one on the same page. Calling `finish()` after cancellation returns an empty, incomplete observation. Repeated calls to `finish()` on a completed capture return the same observation.

Record each test separately and merge worker outputs by root-relative test file and test ID. Each observation has a list of original function scopes and a completeness flag. For direct V8 input, call `map(scripts)` once per test with that test's generated script sources and function ranges. Mark partial captures as incomplete. A suite-wide aggregate cannot identify individual tests.

Pass the resulting object as `observations` to the Node API, or as JSON with `--coverage <file>`. Use observations collected from the baseline you are comparing against, with the same runner configuration. Supply the full inventory of tests in each recorded file. Omit a file's record if its inventory is unknown. Files without observations and tests with incomplete captures stay candidates for changed source. Unobserved functions, whole-file edits and lines shared with module-level code use broader selection. The CLI reports invalid observation fields with their test file and ID. Each `complete` value must be a JSON boolean and `scopes` must be an array of strings.
