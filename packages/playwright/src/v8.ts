import type { BrowserContext, Frame, Page } from '@playwright/test';
import { RunnerSetupError } from '@mizchi/mutator-core';
import { type ScriptCoverage, createSourceCoverageMapper } from './source-coverage.ts';

/** Attach before the default page is handed to the test. Additional pages are
 * observed too, but conservatively flagged: a popup can load before attachment. */
export async function startSourceCoverage(context: BrowserContext, page: Page, browserName: string, map: ReturnType<typeof createSourceCoverageMapper>) {
  if (browserName !== 'chromium') throw new RunnerSetupError('playwright source coverage requires Chromium; disable playwrightSourceCoverage for other browser projects');
  let complete = true;
  const pages = new Map<Page, Promise<boolean>>();
  const cleanups: (() => void)[] = [];
  const attach = (p: Page) => {
    if (pages.has(p)) return pages.get(p)!;
    let navigations = 0;
    const navigation = (frame: Frame) => {
      if (frame !== p.mainFrame()) { complete = false; return; }
      if (frame.url() !== 'about:blank' && ++navigations > 1) complete = false;
    };
    const lost = () => { complete = false; };
    p.on('framenavigated', navigation);
    p.on('close', lost);
    p.on('worker', lost);
    cleanups.push(() => { p.off('framenavigated', navigation); p.off('close', lost); p.off('worker', lost); });
    const started = p.coverage.startJSCoverage({ resetOnNavigation: false }).then(() => true, () => { complete = false; return false; });
    pages.set(p, started);
    return started;
  };
  const extra = (p: Page) => { complete = false; void attach(p); };
  context.on('page', extra);
  // Service workers and pre-existing frames are separate targets, outside this collector.
  if (context.serviceWorkers().length || page.frames().length > 1) complete = false;
  context.on('serviceworker', extraWorker);
  function extraWorker() { complete = false; }
  for (const p of context.pages()) {
    if (p !== page) complete = false;
    await attach(p);
  }
  await attach(page);

  const dispose = () => {
    context.off('page', extra);
    context.off('serviceworker', extraWorker);
    for (const cleanup of cleanups) cleanup();
  };
  return {
    dispose,
    async finish() {
      const entries: ScriptCoverage[] = [];
      try {
        for (const [p, started] of pages) {
          if (!await started) continue;
          try { entries.push(...await p.coverage.stopJSCoverage()); }
          catch { complete = false; }
        }
        const observed = map(entries);
        return { scopes: observed.scopes, complete: complete && observed.complete };
      } finally { dispose(); }
    },
  };
}

export { createSourceCoverageMapper };
