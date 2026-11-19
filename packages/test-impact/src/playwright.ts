import type { BrowserContext, Frame, Page } from '@playwright/test';
import { type ScriptCoverage, type SourceObservation, createSourceCoverageMapper } from './source-coverage.ts';

/** Attach before the default page is handed to the test. Additional pages are
 * observed too, but conservatively flagged: a popup can load before attachment. */
export async function startChromiumCoverage(context: BrowserContext, page: Page, map: ReturnType<typeof createSourceCoverageMapper>) {
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

  async function stop(collect: boolean): Promise<SourceObservation> {
    context.off('page', extra);
    context.off('serviceworker', extraWorker);
    const entries: ScriptCoverage[] = [];
    try {
      for (const [p, started] of pages) {
        if (!await started) continue;
        try {
          const scripts = await p.coverage.stopJSCoverage();
          if (collect) entries.push(...scripts);
        } catch { complete = false; }
      }
    } finally {
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      pages.clear();
    }
    if (!collect) return { scopes: [], complete: false };
    const observed = map(entries);
    return { scopes: observed.scopes, complete: complete && observed.complete };
  }

  let stopped: Promise<SourceObservation> | undefined;
  return {
    /** Stop all captures and discard the result if finish has not started. */
    async dispose(): Promise<void> { await (stopped ??= stop(false)); },
    /** Repeated calls return the same observation. A discarded capture is incomplete. */
    finish(): Promise<SourceObservation> { return stopped ??= stop(true); },
  };
}

export { createSourceCoverageMapper };
