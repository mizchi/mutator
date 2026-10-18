---
name: mutator-playwright
description: Set up mutation testing of browser code that Playwright Test drives end to end, with mutator (@mizchi/mutator) and @mizchi/mutator-playwright, for an app served by a Vite dev server. Use when adding mutation testing to E2E tests, when `mutator --runner playwright` fails to start or finds no coverage, or when E2E mutation runs are slow.
license: MIT
compatibility: Node.js 24+, @playwright/test 1.50+, Vite 6+, and an app served through the Playwright config's webServer
---

# mutator with Playwright (E2E)

mutator compiles every mutant of the app's sources into the modules the Vite dev server serves, and the page decides which one is active. One dev server serves every mutant; each mutant run is a `playwright test` process running only the tests that reached the mutant. For mutator in general (reports, config, CI) see the `mutator` skill in `@mizchi/mutator`.

## Requirements

- The app is served by a **Vite** dev server, started by the Playwright config's `webServer` (with a `url` or a `port`).
- The tests drive the app in a browser. Node-side code (API tests, component testing) is not a target.

## Setup

1. Install:

   ```sh
   pnpm add -D @mizchi/mutator @mizchi/mutator-playwright
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

4. Run with the runner named (the app's `vite.config.*` would make `auto` pick Vitest):

   ```sh
   npx mutator --runner playwright --include 'src/**/*.ts'
   ```

   Or put it in `mutator.config.json`: `{ "runner": "playwright", "include": ["src/**/*.ts"] }`, and `playwrightConfig` for a config file other than `playwright.config.*` in the root.

## How a run works

- When a run is needed (a run with nothing to re-run starts no server), mutator starts the `webServer` itself, once, and runs Playwright through a generated config next to the project's (removed when the run ends) that extends it without `webServer`. **Nothing may already listen on the server's url**: stop a dev server you started by hand.
- In the dry run the fixture records which mutants each test reached in the page, also across same-origin navigations. Every test file counts as depending on every mutated file.
- A mutant run uses one worker, `--retries=0` and `--max-failures=1` (all failing tests with `--kill-matrix`). Tests are selected by `file:line`, and by `--project` when the config has several projects; test ids then start with `[project]`.
- In mutant runs `expect` waits at most three times as long as the slowest selected test took in the dry run (at least 1 s, never longer than the config's timeout). A killed mutant mostly waits for its failing assertion.

## Troubleshooting

| symptom | cause and fix |
|---|---|
| `... already answers; stop that server` | a server already listens on the `webServer` url: stop it (or change the port) |
| `webServer ... has neither url nor port` | give the `webServer` a `url` or a `port`, as Playwright requires |
| `the dev server (...) exited before ... answered` | the `webServer` command fails on its own: run it by hand to see why |
| every mutant `NoCoverage` | the plugin is missing from the Vite config, the tests import `test` from `@playwright/test`, or `include` does not match the files the browser loads |
| `Ignored` mutants | logging-only code (`console.log(...)`, arid) and accepted ones are not run |
| exit 4, tests fail without mutants | the E2E tests fail without any mutant: fix them (or their flakiness) first |
| many `Timeout`s | a mutant that hangs the page times out (it counts as detected). A run that only ran out of time is re-run once with three times the budget first; if that is not enough, the machine is overloaded: lower `-j` |
| slow runs | about 1–2 s per mutant run on a small app: use `--since`, `--time-budget` and `-j` (parallel runs share the dev server) |

## Limits

Not supported yet: dev servers other than Vite, a server not started through `webServer`, coverage of pages closed before the test ends, plugin objects (plugin modules work: the dev server loads them itself).
