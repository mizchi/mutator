import { defineConfig } from '@mizchi/mutator';

export default defineConfig({
  runner: 'playwright',
  playwrightConfig: 'playwright.config.ts',
  playwrightSourceCoverage: true,
  include: ['src/cart.ts', 'src/normalize-quantity.ts', 'src/profile.ts'],
  // This leaves the identity helper without mutants, so source coverage is
  // needed to associate its edits with the cart E2E.
  excludedMutators: ['ArrowFunction'],
  concurrency: 2,
  // Keep this example focused on browser detection. `pnpm typecheck` is separate.
  typecheck: false,
  timeBudget: 60,
  reporters: ['text', 'json'],
});
