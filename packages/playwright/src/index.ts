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
import type { ContextLike } from './page.ts';

export { expect } from '@playwright/test';

// Read when the worker starts: Playwright starts new workers for every run.
const run: RunConfig | undefined = process.env[RUN_FILE_ENV] ? (JSON.parse(readFileSync(process.env[RUN_FILE_ENV], 'utf8')) as RunConfig) : undefined;

export interface MutatorFixtures {
  _mutator: void;
}

// Loaded only for opted-in dry runs. Ordinary Playwright tests and mutant runs
// retain the original fixture, including its lazy creation of the default page.
const v8 = run?.sourceCoverage && run.active === null ? await import('./v8.ts') : undefined;
const mapper = v8 && run?.sourceCoverage ? v8.createSourceCoverageMapper(run.sourceCoverage) : undefined;

/** The fixtures behind `test`, for projects that extend their own test: `base.extend(mutatorFixtures)`. */
export const mutatorFixtures: Fixtures<MutatorFixtures, {}, PlaywrightTestArgs & PlaywrightTestOptions, PlaywrightWorkerArgs & PlaywrightWorkerOptions> = {
  _mutator: [
    // Playwright passes its BrowserContext and TestInfo, wider than the parts fixtureBody uses.
    (v8 && mapper ? async ({ context, page, browserName }: PlaywrightTestArgs & PlaywrightWorkerOptions, use: () => Promise<void>, testInfo: Parameters<ReturnType<typeof fixtureBody>>[2]) => {
      const collector = await v8.startSourceCoverage(context, page, browserName, mapper);
      try { await fixtureBody(run, () => collector.finish())({ context: context as unknown as ContextLike }, use, testInfo); }
      finally { collector.dispose(); }
    } : fixtureBody(run)) as never,
    { auto: true },
  ],
};

export const test = base.extend<MutatorFixtures>(mutatorFixtures);
