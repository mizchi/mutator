---
name: mutator-playwright
description: Set up mutation testing of browser code that Playwright Test drives end to end, with mutator (@mizchi/mutator) and @mizchi/mutator-playwright, for an app served by a Vite dev server. Use when adding mutation testing to E2E tests, when `mutator --runner playwright` fails to start or finds no coverage, or when E2E mutation runs are slow.
license: MIT
compatibility: Node.js 24+, @playwright/test 1.50+, Vite 6+, and an app served through the Playwright config's webServer
---

# mutator with Playwright (E2E)

mutator compiles every mutant of the app's sources into the modules the Vite dev server serves, and the page decides which one is active. One dev server serves every mutant; each mutant run is a `playwright test` process running only the tests that reached the mutant. For mutator in general (reports, config, CI) see the `mutator` skill in `@mizchi/mutator`.

**Disabled by default.** `runner: 'auto'` selects Vitest or Jest, never Playwright. An installed `@playwright/test` or a `playwright.config.*` does not opt the project into browser mutation testing. Enable it explicitly in `mutator.config.ts`.

**Runtime warning:** Each mutant run starts a new Playwright Test process and executes browser tests. Startup and failing assertion waits make this much slower than a warm unit-test runner; large runs can take many minutes or hours. Start with a small include, sampling, a time budget and modest concurrency. Estimates appear after the baseline and type checking, and a time budget stops new runs rather than interrupting tests already in flight.

## Requirements

- The app is served by a **Vite** dev server, started by the Playwright config's `webServer` (with a `url` or a `port`).
- The tests drive the app in a browser. Node-side code (API tests, component testing) is not a target.

## Runnable example

The [Playwright source-coverage sample](https://github.com/mizchi/mutator/blob/main/examples/playwright-source-coverage/README.md) is a complete Vite/Chromium app with cart and profile E2Es, the plugin, the fixture and `mutator.config.ts`. It explicitly enables `runner: 'playwright'` and `playwrightSourceCoverage: true`.

From a checkout of `mizchi/mutator`:

```sh
pnpm install --frozen-lockfile
pnpm --dir examples/playwright-source-coverage exec playwright install chromium
pnpm --dir examples/playwright-source-coverage run verify
```

The verifier uses a disposable copy and a free port. It checks ordinary E2Es, per-function source correspondence (including a helper with no mutants), unchanged cache reuse, selection and re-execution after a source-only edit, and agreement with a cold full run. Results and logs are retained. The sample also provides `just verify` from its directory.

## Setup

1. Install:

   ```sh
   pnpm add -D @mizchi/mutator @mizchi/mutator-playwright
   pnpm exec playwright install chromium
   ```

2. Add the plugin to the app's Vite config. It does nothing unless mutator starts the dev server, so it can stay there:

   ```ts
   // vite.config.ts
   import { mutatorVite } from '@mizchi/mutator-playwright/vite';
   import { defineConfig } from 'vite';

   export default defineConfig({ plugins: [mutatorVite()] });
   ```

3. Import `test` and `expect` from the adapter in every test file, instead of `@playwright/test`. Outside mutator runs it behaves as Playwright's own:

   ```ts
   import { expect, test } from '@mizchi/mutator-playwright';
   ```

   A project with its own fixtures extends them instead:

   ```ts
   import { test as base } from '@playwright/test';
   import { mutatorFixtures } from '@mizchi/mutator-playwright';

   export const test = base.extend(mutatorFixtures).extend({ /* your fixtures */ });
   export { expect } from '@playwright/test';  // the adapter re-exports this same expect
   ```

   Typed fixtures chain as usual: `base.extend(mutatorFixtures).extend<{ page2: Page2 }>({ ... })`.

4. Have the Playwright config start the Vite dev server, with a URL and a separate browser-test directory:

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

   For Vite+, import `defineConfig` from `vite-plus` in the Vite config and use `pnpm exec vp dev --host 127.0.0.1 --port 4173 --strictPort` as the server command. Keep `e2e/**` out of the unit runner's include patterns.

5. Enable the runner explicitly:

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

6. Check the ordinary E2E baseline, then run mutator:

   ```sh
   pnpm exec playwright test
   pnpm exec mutator
   pnpm exec mutator --since main  # later runs: changed code only
   ```

   Sampling and the budget leave unrun mutants Pending; raise or remove those limits for a full run. A one-off explicit `--runner playwright` or `--playwright-config <file>` also enables the adapter.

## How a run works

- When a run is needed (a run with nothing to re-run starts no server), mutator starts the `webServer` itself, once, and runs Playwright through a generated config next to the project's (removed when the run ends) that extends it without `webServer`. **Nothing may already listen on the server's url**: stop a dev server you started by hand.
- In the dry run the fixture records which mutants each test reached in the page, also across same-origin navigations. Every test file counts as depending on every mutated file.
- A mutant run uses one worker, `--retries=0` and `--max-failures=1` (all failing tests with `--kill-matrix`). Tests are selected by `file:line` and `--project`. With several projects, test ids start with `[project]` (see them in `coveredBy` / `killedBy` of `--reporter agent` or `json`); `killedBy` names only the first failing project unless `--kill-matrix`, which also shows projects that kill the same mutants. For a per-project view, run `--kill-matrix --reporter json` and group `killedBy` by the `[project]` prefix.
- In mutant runs `expect` waits at most three times as long as the slowest selected test took in the dry run (at least 1 s, never longer than the config's timeout). A killed mutant mostly waits for its failing assertion.

## Optional original-source coverage

Set `playwrightSourceCoverage: true` in `mutator.config.ts` to collect Chromium V8 coverage during dry runs and map it through inline source maps with `sourcesContent` to original function scopes. It is **disabled by default** and adds CPU and memory cost. Keep all Playwright projects on Chromium when enabling it. Only sources in the mutation include are indexed.

The snapshot's `sourceCoverage` is an inverse index from `relative/source.ts#scopeId` to test ids, including functions with no mutants. It is used for incremental dry-run planning and `select-tests --since`; source hashes remain in `scopes`. Unknown scopes and top-level dependencies keep the broad fallback. Navigations, popups, frames, closed pages, workers and missing/stale maps mark tests in `sourceCoverageIncomplete`; keep them as affected-source candidates. Never interpret this index as proof that assertions detect changes. Mutant runs do not collect V8 coverage and continue to use their exact probes.

## Troubleshooting

| symptom | cause and fix |
|---|---|
| `... already answers; stop that server` | a server already listens on the `webServer` url: stop it (or change the port) |
| `webServer ... has neither url nor port` | give the `webServer` a `url` or a `port`, as Playwright requires |
| `the dev server (...) exited before ... answered` | the `webServer` command fails on its own: run it by hand to see why |
| every mutant `NoCoverage` (a `noCoverage` warning) | the plugin is missing from the Vite config, the tests import `test` from `@playwright/test` (or a fixtures file extends it without `mutatorFixtures`), or `include` does not match the files the browser loads. After fixing a helper or fixtures file, the next run re-collects coverage by itself |
| `Ignored` mutants | logging-only code (`console.log(...)`, arid) and accepted ones are not run |
| exit 4, tests fail without mutants | the E2E tests fail without any mutant: fix them (or their flakiness) first |
| many `Timeout`s | a mutant that hangs the page times out (it counts as detected). A run that only ran out of time is re-run once with three times the budget first; if that is not enough, the machine is overloaded: lower `-j` |
| slow runs | about 1–2 s per mutant run on a small app: use `--since`, `--time-budget` and `-j` (parallel runs share the dev server) |

## Limits

Not supported yet: dev servers other than Vite, a server not started through `webServer`, coverage of pages closed before the test ends, plugin objects (plugin modules work: the dev server loads them itself).
