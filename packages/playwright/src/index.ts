// Fixture for the Playwright workers. Import `test` / `expect` from here instead of
// @playwright/test (or extend your own test with `mutatorFixtures`). Outside mutator runs
// it does nothing.
//
// Each test gets its own browser context; an init script sets the runtime state of the
// instrumented code in every document before the app's scripts run: the active mutant and
// the test's id. Coverage of a document that is left (a navigation) is kept in
// sessionStorage, and read with the live documents' when the test ends.
import { readFileSync } from 'node:fs';
import {
  type Fixtures,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  test as base,
} from '@playwright/test';
import { RUN_FILE_ENV, type RunConfig } from './env.ts';
import { fixtureBody } from './page.ts';

export { expect } from '@playwright/test';

// Read when the worker starts: Playwright starts new workers for every run.
const run: RunConfig | undefined = process.env[RUN_FILE_ENV] ? (JSON.parse(readFileSync(process.env[RUN_FILE_ENV], 'utf8')) as RunConfig) : undefined;

export interface MutatorFixtures {
  _mutator: void;
}

/** The fixtures behind `test`, for projects that extend their own test: `base.extend(mutatorFixtures)`. */
export const mutatorFixtures: Fixtures<MutatorFixtures, {}, PlaywrightTestArgs & PlaywrightTestOptions, PlaywrightWorkerArgs & PlaywrightWorkerOptions> = {
  _mutator: [
    // Playwright passes its BrowserContext and TestInfo, wider than the parts fixtureBody uses.
    fixtureBody(run) as never,
    { auto: true },
  ],
};

export const test = base.extend<MutatorFixtures>(mutatorFixtures);
