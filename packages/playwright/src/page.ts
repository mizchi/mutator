// The fixture's parts that run without Playwright's test runner: the script each document of
// a test's context runs, collecting what the pages observed, and the fixture's body. Split from
// index.ts so they can be tested in process.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RUNTIME_GLOBAL, RuntimeState } from '@mizchi/mutator-core';
import type { RunConfig, TestRecord } from './env.ts';

/** The parts of Playwright's BrowserContext used here. */
export interface ContextLike {
  addInitScript<A>(script: (arg: A) => void, arg: A): Promise<void>;
  pages(): { frames(): { evaluate<R>(fn: () => R): Promise<R> }[] }[];
}

/** The parts of Playwright's TestInfo used here. */
export interface TestInfoLike {
  file: string;
  titlePath: string[];
  project: { name: string };
  workerIndex: number;
}

/** What a document observed: mutants reached, infected, and hit counts. */
export interface Observed {
  hits: Record<string, number>;
  infected: Record<string, number>;
  counts: Record<string, number>;
}

export interface PageConfig {
  active: string | null;
  collect: boolean;
  hitLimit: number;
  id: string;
}

/** Runs in every document of the context, before any of its scripts. Self-contained. */
export function pageSetup(config: PageConfig): void {
  const STORE = '__mutator_pw';
  // Serialised into the page, so core's constant cannot be imported; the type keeps them equal.
  const GLOBAL: typeof RUNTIME_GLOBAL = '__mutator__';
  const g = globalThis as Record<string, unknown>;
  const state = {
    active: config.active,
    collect: config.collect,
    cov: { static: {} as Record<string, number>, perTest: {} as Record<string, Record<string, number>> },
    inf: { static: {} as Record<string, number>, perTest: {} as Record<string, Record<string, number>> },
    modules: [] as [readonly string[], ArrayLike<number>][],
    testId: config.id,
    hits: 0,
    hitLimit: config.hitLimit,
  } satisfies Required<RuntimeState>;
  g[GLOBAL] = state;
  if (!config.collect) return;
  const own = (): { hits: Record<string, number>; infected: Record<string, number>; counts: Record<string, number> } => {
    const counts: Record<string, number> = {};
    for (const [keys, n] of state.modules) for (let i = 0; i < keys.length; i++) if (n[i]) counts[keys[i]!] = (counts[keys[i]!] ?? 0) + n[i]!;
    return { hits: { ...state.cov.perTest[config.id] }, infected: { ...state.inf.perTest[config.id] }, counts };
  };
  const merge = (a: ReturnType<typeof own>, b: ReturnType<typeof own>) => {
    const counts = { ...a.counts };
    for (const [k, n] of Object.entries(b.counts)) counts[k] = (counts[k] ?? 0) + n;
    return { hits: { ...a.hits, ...b.hits }, infected: { ...a.infected, ...b.infected }, counts };
  };
  const stored = (): ReturnType<typeof own> => {
    try {
      return JSON.parse(sessionStorage.getItem(STORE) ?? 'null') ?? { hits: {}, infected: {}, counts: {} };
    } catch {
      return { hits: {}, infected: {}, counts: {} };
    }
  };
  addEventListener('pagehide', () => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(merge(stored(), own())));
    } catch {
      // No storage (opaque origin): what this document saw is lost.
    }
  });
  g.__mutator_pw_observed = () => merge(stored(), own());
}

export async function observed(context: Pick<ContextLike, 'pages'>): Promise<Observed> {
  const out: Observed = { hits: {}, infected: {}, counts: {} };
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      const seen = await frame
        .evaluate(() => (globalThis as { __mutator_pw_observed?: () => Observed }).__mutator_pw_observed?.())
        .catch(() => undefined);
      if (!seen) continue;
      Object.assign(out.hits, seen.hits);
      Object.assign(out.infected, seen.infected);
      // Frames of one origin share the stored part: keep the larger count instead of adding it twice.
      for (const [k, n] of Object.entries(seen.counts)) out.counts[k] = Math.max(out.counts[k] ?? 0, n);
    }
  }
  return out;
}

/**
 * The fixture's body for a run (`undefined` outside mutator runs): set the page script up,
 * run the test, and in the dry run append what its pages observed to the worker's JSONL file.
 */
export function fixtureBody(run: RunConfig | undefined) {
  return async ({ context }: { context: ContextLike }, use: () => Promise<void>, testInfo: TestInfoLike): Promise<void> => {
    if (!run) return use();
    const titles = testInfo.titlePath.slice(1);
    const id = JSON.stringify([testInfo.file, testInfo.project.name, titles]);
    await context.addInitScript(pageSetup, { active: run.active, collect: run.active === null, hitLimit: run.hitLimit, id } satisfies PageConfig);
    await use();
    if (!run.out) return;
    const record: TestRecord = { file: testInfo.file, project: testInfo.project.name, titles, ...(await observed(context)) };
    appendFileSync(join(run.out, `${testInfo.workerIndex}-${process.pid}.jsonl`), `${JSON.stringify(record)}\n`);
  };
}
