import type { BrowserContext, Page } from '@playwright/test';
import { RunnerSetupError } from '@mizchi/mutator-core';
import { createSourceCoverageMapper, startChromiumCoverage } from '@mizchi/test-impact/playwright';

export async function startSourceCoverage(context: BrowserContext, page: Page, browserName: string, map: ReturnType<typeof createSourceCoverageMapper>) {
  if (browserName !== 'chromium') throw new RunnerSetupError('playwright source coverage requires Chromium; disable playwrightSourceCoverage for other browser projects');
  return startChromiumCoverage(context, page, map);
}

export { createSourceCoverageMapper };
