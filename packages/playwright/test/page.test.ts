// The fixture's page script and body, in process: the page globals (sessionStorage,
// addEventListener) are stand-ins, and the context hands the script to a "document" directly.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type ContextLike, type Observed, type PageConfig, fixtureBody, observed, pageSetup } from '../src/page.ts';

const g = globalThis as Record<string, unknown>;

/** A browser tab: its sessionStorage outlives documents; each document gets its own listeners. */
function tab(storage: Map<string, string> | 'broken' = new Map()) {
  let listeners: Record<string, () => void> = {};
  g.sessionStorage = {
    getItem: (k: string) => {
      if (storage === 'broken') throw new Error('opaque origin');
      return storage.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (storage === 'broken') throw new Error('opaque origin');
      storage.set(k, v);
    },
  };
  g.addEventListener = (type: string, listener: () => void) => (listeners[type] = listener);
  return {
    storage,
    /** A new document: the page script runs, then `fill` stands for the instrumented code. */
    load(config: PageConfig, fill: (state: RuntimeState) => void = () => {}) {
      listeners = {};
      pageSetup(config);
      fill(g.__mutator__ as RuntimeState);
    },
    leave: () => listeners.pagehide?.(),
    observed: () => (g.__mutator_pw_observed as (() => Observed) | undefined)?.(),
  };
}

interface RuntimeState {
  active: string | null;
  collect: boolean;
  testId: string;
  hitLimit: number;
  cov: { perTest: Record<string, Record<string, number>> };
  inf: { perTest: Record<string, Record<string, number>> };
  modules: [readonly string[], ArrayLike<number>][];
}

const config = (extra: Partial<PageConfig> = {}): PageConfig => ({ active: null, collect: true, hitLimit: 1000, id: 't1', ...extra });

beforeEach(() => {
  for (const key of ['__mutator__', '__mutator_pw_observed', 'sessionStorage', 'addEventListener']) delete g[key];
});
afterEach(() => {
  for (const key of ['__mutator__', '__mutator_pw_observed', 'sessionStorage', 'addEventListener']) delete g[key];
});

describe('pageSetup', () => {
  test('sets the runtime state the instrumented code reads', () => {
    tab().load(config({ active: 'k9', collect: false, hitLimit: 42, id: 'the test' }));
    expect(g.__mutator__).toMatchObject({ active: 'k9', collect: false, testId: 'the test', hits: 0, hitLimit: 42, cov: { static: {}, perTest: {} }, inf: { static: {}, perTest: {} }, modules: [] });
  });

  test('a mutant run collects nothing: no observer, nothing kept on leaving', () => {
    const t = tab();
    t.load(config({ active: 'k9', collect: false }), (s) => (s.cov.perTest.t1 = { k1: 1 }));
    t.leave();
    expect(t.observed()).toBeUndefined();
    expect(t.storage).toEqual(new Map());
  });

  test("reports the test's hits, infections and hit counts summed per mutant", () => {
    const t = tab();
    t.load(config(), (s) => {
      s.cov.perTest.t1 = { k1: 1 };
      s.cov.perTest.other = { k8: 1 };
      s.inf.perTest.t1 = { k2: 1 };
      s.modules.push([['k1', 'k3'], [2, 0]], [['k1'], [5]]);
    });
    expect(t.observed()).toEqual({ hits: { k1: 1 }, infected: { k2: 1 }, counts: { k1: 7 } });
  });

  test("keeps a left document's observations for the next document of the tab", () => {
    const t = tab();
    t.load(config(), (s) => {
      s.cov.perTest.t1 = { k1: 1 };
      s.inf.perTest.t1 = { k5: 1 };
      s.modules.push([['k1'], [2]]);
    });
    t.leave();
    t.load(config(), (s) => {
      s.cov.perTest.t1 = { k4: 1 };
      s.modules.push([['k1', 'k4'], [3, 1]]);
    });
    expect(t.observed()).toEqual({ hits: { k1: 1, k4: 1 }, infected: { k5: 1 }, counts: { k1: 5, k4: 1 } });
  });

  test('without storage (an opaque origin) a document still reports what it saw, and leaving does not throw', () => {
    const t = tab('broken');
    t.load(config(), (s) => (s.cov.perTest.t1 = { k1: 1 }));
    expect(t.leave).not.toThrow();
    expect(t.observed()).toEqual({ hits: { k1: 1 }, infected: {}, counts: {} });
  });
});

describe('observed', () => {
  // A frame runs the evaluated function against its own document's globals.
  const frame = (seen: Observed | undefined | 'detached') => ({
    evaluate: async <R>(fn: () => R) => {
      if (seen === 'detached') throw new Error('frame was detached');
      if (seen) g.__mutator_pw_observed = () => seen;
      else delete g.__mutator_pw_observed;
      return fn();
    },
  });

  test('merges every frame of every page; a count shared through storage is not added twice', async () => {
    const context = {
      pages: () => [
        { frames: () => [frame({ hits: { a: 1 }, infected: { x: 1 }, counts: { a: 3, b: 1 } }), frame(undefined), frame('detached')] },
        { frames: () => [frame({ hits: { b: 1 }, infected: {}, counts: { a: 2, b: 4 } })] },
      ],
    };
    expect(await observed(context)).toEqual({ hits: { a: 1, b: 1 }, infected: { x: 1 }, counts: { a: 3, b: 4 } });
  });
});

describe('fixtureBody', () => {
  const testInfo = { file: '/p/tests/a.spec.ts', titlePath: ['a.spec.ts', 'group', 'adds'], project: { name: 'chromium' }, workerIndex: 3 };
  const context = (seen: Observed) => {
    const scripts: unknown[] = [];
    const ctx: ContextLike = {
      addInitScript: async (script, arg) => void scripts.push([script, arg]),
      pages: () => [{ frames: () => [{ evaluate: async () => seen as never }] }],
    };
    return { ctx, scripts };
  };
  let out: string;
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'mutator-fixture-'));
  });
  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
  });

  test('outside mutator runs it only runs the test', async () => {
    const { ctx, scripts } = context({ hits: {}, infected: {}, counts: {} });
    let ran = false;
    await fixtureBody(undefined)({ context: ctx }, async () => void (ran = true), testInfo);
    expect(ran).toBe(true);
    expect(scripts).toEqual([]);
  });

  test("in the dry run it sets the page script up for the test, then records what the test's pages observed", async () => {
    const seen = { hits: { k1: 1 }, infected: { k2: 1 }, counts: { k1: 4 } };
    const { ctx, scripts } = context(seen);
    const order: string[] = [];
    ctx.addInitScript = async (script, arg) => void (order.push('script'), scripts.push([script, arg]));
    await fixtureBody({ active: null, hitLimit: 77, out, results: join(out, 'r.json') })({ context: ctx }, async () => void order.push('test'), testInfo);
    expect(order).toEqual(['script', 'test']);
    expect(scripts).toEqual([[pageSetup, { active: null, collect: true, hitLimit: 77, id: JSON.stringify(['/p/tests/a.spec.ts', 'chromium', ['group', 'adds']]) }]]);
    expect(readdirSync(out)).toEqual([`3-${process.pid}.jsonl`]);
    const lines = readFileSync(join(out, `3-${process.pid}.jsonl`), 'utf8').split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ file: '/p/tests/a.spec.ts', project: 'chromium', titles: ['group', 'adds'], ...seen });
  });

  test('in a mutant run it activates the mutant and records nothing', async () => {
    const { ctx, scripts } = context({ hits: { k1: 1 }, infected: {}, counts: {} });
    await fixtureBody({ active: 'k9', hitLimit: 5, results: join(out, 'r.json') })({ context: ctx }, async () => {}, testInfo);
    expect(scripts).toEqual([[pageSetup, expect.objectContaining({ active: 'k9', collect: false, hitLimit: 5 })]]);
    expect(readdirSync(out)).toEqual([]);
  });
});
