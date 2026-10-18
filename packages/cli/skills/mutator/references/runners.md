# Runners

`--runner auto` picks from the root's config files: `vitest.config.*` / `vite.config.*`, then `jest.config.*` or a `jest` field in package.json, then `playwright.config.*`; without any, the runner that resolves from the root. Pass `--runner` (or `runner` in the config) when the guess is wrong.

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

## Playwright (experimental)

Browser code an app serves through a Vite dev server, tested end to end. Needs a Vite plugin in the app and the fixture in the tests: see the `mutator-playwright` skill in `@mizchi/mutator-playwright`.
