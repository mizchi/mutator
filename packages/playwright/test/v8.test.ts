import { EventEmitter } from 'node:events';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from 'vitest';
import { startSourceCoverage } from '../src/v8.ts';

function browser() {
  const events: string[] = [];
  const frame = { url: () => 'http://localhost/' };
  const page = Object.assign(new EventEmitter(), {
    mainFrame: () => frame,
    frames: () => [frame],
    coverage: {
      startJSCoverage: async () => { events.push('start'); },
      stopJSCoverage: async () => { events.push('stop'); return []; },
    },
  });
  const context = Object.assign(new EventEmitter(), { pages: () => [page], serviceWorkers: () => [] });
  const start = (name = 'chromium') => startSourceCoverage(context as unknown as BrowserContext, page as unknown as Page, name, () => ({ complete: true, scopes: ['src/a.ts#f'] }));
  return { page, context, frame, events, start };
}

test('collects the default page before use and removes event listeners after finishing', async () => {
  const b = browser();
  const collector = await b.start();
  expect(b.events).toEqual(['start']);
  b.page.emit('framenavigated', b.frame);
  expect(await collector.finish()).toEqual({ complete: true, scopes: ['src/a.ts#f'] });
  expect(b.events).toEqual(['start', 'stop']);
  expect(b.context.listenerCount('page')).toBe(0);
  expect(b.page.listenerCount('framenavigated')).toBe(0);
});

test.each(['close', 'worker', 'navigation', 'frame', 'popup', 'serviceworker', 'stop failure'])('%s makes the collector incomplete, retaining positive observations', async (event) => {
  const b = browser();
  const collector = await b.start();
  if (event === 'navigation') { b.page.emit('framenavigated', b.frame); b.page.emit('framenavigated', b.frame); }
  else if (event === 'frame') b.page.emit('framenavigated', {});
  else if (event === 'popup') b.context.emit('page', b.page);
  else if (event === 'serviceworker') b.context.emit('serviceworker');
  else if (event === 'stop failure') b.page.coverage.stopJSCoverage = async () => { throw new Error('closed'); };
  else b.page.emit(event);
  expect((await collector.finish()).complete).toBe(false);
});

test('rejects unsupported browsers explicitly', async () => {
  const b = browser();
  await expect(b.start('firefox')).rejects.toThrow('requires Chromium');
  expect(b.events).toEqual([]);
});

test('dispose and finish share one stop for each attached page', async () => {
  const b = browser();
  const popup = browser();
  const collector = await b.start();
  b.context.emit('page', popup.page);
  await Promise.all([collector.dispose(), collector.dispose()]);
  expect(b.events).toEqual(['start', 'stop']);
  expect(popup.events).toEqual(['start', 'stop']);
  expect(b.context.listenerCount('page')).toBe(0);
  const next = await b.start();
  await Promise.all([next.finish(), next.dispose(), next.finish()]);
  expect(b.events).toEqual(['start', 'stop', 'start', 'stop']);
});
