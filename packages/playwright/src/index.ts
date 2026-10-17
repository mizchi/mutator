// Fixture for the Playwright workers. Import `test` / `expect` from here instead of
// @playwright/test (or extend your own test with `mutatorFixtures`). Outside mutator runs
// it does nothing.
//
// Each test gets its own browser context; an init script sets the runtime state of the
// instrumented code in every document before the app's scripts run: the active mutant and
// the test's id. Coverage of a document that is left (a navigation) is kept in
// sessionStorage, and read with the live documents' when the test ends.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BrowserContext,
  type Fixtures,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  test as base,
} from '@playwright/test';
import { RUN_ENV, type RunConfig, type TestRecord } from './env.ts';

export { expect } from '@playwright/test';

const run: RunConfig | undefined = process.env[RUN_ENV] ? (JSON.parse(process.env[RUN_ENV]) as RunConfig) : undefined;

/** What a document observed: mutants reached, infected, and hit counts. */
interface Observed {
  hits: Record<string, number>;
  infected: Record<string, number>;
  counts: Record<string, number>;
}

interface PageConfig {
  active: string | null;
  collect: boolean;
  hitLimit: number;
  id: string;
}

/** Runs in every document of the context, before any of its scripts. Self-contained. */
function pageSetup(config: PageConfig): void {
  const STORE = '__mutator_pw';
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
  };
  g.__mutator__ = state;
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

async function observed(context: BrowserContext): Promise<Observed> {
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

export interface MutatorFixtures {
  _mutator: void;
}

/** The fixtures behind `test`, for projects that extend their own test: `base.extend(mutatorFixtures)`. */
export const mutatorFixtures: Fixtures<MutatorFixtures, {}, PlaywrightTestArgs & PlaywrightTestOptions, PlaywrightWorkerArgs & PlaywrightWorkerOptions> = {
  _mutator: [
    async ({ context }, use, testInfo) => {
      if (!run) return use();
      const titles = testInfo.titlePath.slice(1);
      const id = JSON.stringify([testInfo.file, testInfo.project.name, titles]);
      await context.addInitScript(pageSetup, { active: run.active, collect: run.active === null, hitLimit: run.hitLimit, id } satisfies PageConfig);
      await use();
      if (!run.out) return;
      const record: TestRecord = { file: testInfo.file, project: testInfo.project.name, titles, ...(await observed(context)) };
      appendFileSync(join(run.out, `${testInfo.workerIndex}-${process.pid}.jsonl`), `${JSON.stringify(record)}\n`);
    },
    { auto: true },
  ],
};

export const test = base.extend<MutatorFixtures>(mutatorFixtures);
