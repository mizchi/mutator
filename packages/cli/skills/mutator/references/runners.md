# Runners

`--runner auto` selects unit runners only: the root's `vitest.config.*` / `vite.config.*`, then `jest.config.*` or a `jest` field in package.json, then installed Vitest / Vite+ or Jest, then Bun's test runner in a Bun project (`bunfig.toml`, `bun.lock` or `bun.lockb`) that has neither. Playwright is never selected automatically from its config files or installed package.

## Vitest (the reference runner)

- Vitest 5. Sources are instrumented in memory by a Vite transform; each mutant runs only the tests that cover it, on parallel single-worker Vitest instances.
- `--config <file>` / `vitestConfig` selects the config.
- Everything is supported: static (module-level) mutants, weak mutation, `test.concurrent`, type checking, child-process detection.

## Jest (experimental)

- Jest 30, native ESM projects only (`"type": "module"`, run as `node --experimental-vm-modules`).
- TypeScript without babel / ts-jest: with `transform: {}` types are stripped by Node (erasable syntax only; set `extensionsToTreatAsEsm: ['.ts']`). A project transformer is kept.
- One Jest process per run (about 0.2–0.3 s each on a small project).
- No weak mutation: a gap that needs another input (a boundary value for `>=` → `>`) is reported as not detected, not as not infected.
- Plugins only as module paths. Not supported: Jest `projects`, `test.concurrent`, retried tests, configs with functions.
- Editing a test helper does not re-collect coverage: use `--full-dry-run` after such edits.

## Bun (experimental)

- `bun test` from Bun 1.4 or later (`bun test --isolate` is required), with `bun` on PATH. The CLI itself still runs on Node.js.
- ESM JavaScript and TypeScript sources. CommonJS sources cannot be mutated: Bun treats a runtime plugin's output as ESM, so their tests fail in the baseline. Exclude them.
- One `bun test` process per run, with a preload that serves the instrumented sources (a few tens of milliseconds each on a small project).
- Per-test coverage, weak mutation, static (module-level) mutants, hit-limit and wall-clock timeouts, `--since`, result reuse, `-j`, `--typecheck`, child-process detection (`Bun.spawn` included), test helper tracking, plugins as modules or objects.
- `test.concurrent` and retried tests: the hits of the whole file are credited to each of its tests (more runs, the same verdicts).
- `--bun-config <file>` / `bunConfig` selects the bunfig.toml (implies the Bun runner). Preloads from bunfig.toml run before mutator's: a source they import is not mutated.
- `*_test.*` and `*_spec.*` files, which `bun test` collects, are excluded from the sources to mutate.

## Playwright (experimental)

Browser code an app serves through a Vite dev server, tested end to end. Needs a Vite plugin in the app and the fixture in the tests: see the `mutator-playwright` skill in `@mizchi/mutator-playwright`.

The [runnable Playwright source-coverage sample](https://github.com/mizchi/mutator/blob/main/examples/playwright-source-coverage/README.md) provides the app, Vite/Playwright/mutator configs and two E2Es. Its verifier checks source correspondence, cache reuse and incremental/cold agreement, including an edit to a function without mutants. Follow its setup instructions in a repository checkout, then run `pnpm --dir examples/playwright-source-coverage run verify`.

Optional `playwrightSourceCoverage: true` in `mutator.config.ts` collects Chromium V8 coverage in dry runs and remaps inline source maps to original function scopes, including those without mutants. It is off by default and adds CPU/memory cost. The snapshot's `sourceCoverage` index supports incremental dry-run planning and `select-tests --since`. Navigations, popups, closed pages, frames, workers and unusable maps make observations incomplete; those tests remain conservative candidates. Mutant selection and verdicts still use the existing exact probes. Only included source files and Chromium projects are supported.

**Opt-in; potentially slow.** Each mutant run starts a separate Playwright Test process and executes the selected browser tests. Browser startup and assertion waits can make a large run take many minutes or hours. Enable it explicitly in the project:

```ts
// mutator.config.ts
import { defineConfig } from '@mizchi/mutator';

export default defineConfig({
  runner: 'playwright',
  playwrightConfig: 'playwright.config.ts',
  include: ['src/**/*.ts'],
  concurrency: 2,
  mutantsPerLine: 1,
  timeBudget: 300,
});
```

Then run `pnpm exec mutator`. Start with a narrow include or `--since`; sampling and the time budget leave other mutants Pending. The time budget stops new runs, while tests already in flight finish. Baseline and type checking precede the runtime estimate and ETA. Keep browser specs out of the unit runner's include patterns. Explicit CLI flags `--runner playwright` and `--playwright-config <file>` remain available for one-off runs.
