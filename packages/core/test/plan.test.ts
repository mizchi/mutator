import { describe, expect, it } from 'vitest';
import { mergeCoverage, plan, testsToRecollect, toResult } from '../src/plan.ts';
import type {
  Mutant,
  MutantResult,
  MutantStatus,
  PlanEntry,
  PlanInput,
  RunSnapshot,
  TestInfo,
} from '../src/types.ts';

// ---- fixtures ---------------------------------------------------------------

const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };

function mutant(key: string, opts: { file?: string; scope?: string; hash?: string; ignored?: string } = {}): Mutant {
  const m: Mutant = {
    key,
    file: opts.file ?? 'a.ts',
    mutator: 'ArithmeticOperator',
    range: { start: 0, end: 1 },
    location: loc,
    original: '+',
    replacement: '-',
    scope: { id: opts.scope ?? 'f', hash: opts.hash ?? 'h1', range: { start: 0, end: 10 }, location: loc },
  };
  if (opts.ignored !== undefined) m.ignored = opts.ignored;
  return m;
}

const test = (id: string, durationMs = 10, fingerprint = 'fp'): TestInfo => ({ id, fingerprint, durationMs });

function result(
  m: Mutant,
  status: MutantStatus,
  coveredBy: string[] = [],
  killedBy: string[] = [],
): MutantResult {
  return toResult(m, status, killedBy, coveredBy);
}

function snapshot(results: MutantResult[], tests: TestInfo[], over: Partial<RunSnapshot> = {}): RunSnapshot {
  return { toolVersion: 'v1', envHash: 'e1', results, tests, ...over };
}

function input(over: Partial<PlanInput> & Pick<PlanInput, 'mutants' | 'tests'>): PlanInput {
  return {
    coverage: undefined,
    staticKeys: new Set(),
    previous: undefined,
    toolVersion: 'v1',
    envHash: 'e1',
    ...over,
  };
}

const cov = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

function only(entries: PlanEntry[]): PlanEntry {
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

function runTests(e: PlanEntry): string[] {
  if (e.kind !== 'run') throw new Error(`expected run, got ${e.kind}`);
  return e.tests;
}

// ---- toResult ---------------------------------------------------------------

describe('toResult', () => {
  it('copies identity from the mutant', () => {
    const m = mutant('k', { file: 'x.ts', scope: 's', hash: 'hh' });
    expect(toResult(m, 'Killed', ['t1'], ['t1', 't2'], 12)).toEqual({
      key: 'k',
      file: 'x.ts',
      scopeId: 's',
      scopeHash: 'hh',
      status: 'Killed',
      killedBy: ['t1'],
      coveredBy: ['t1', 't2'],
      durationMs: 12,
    });
  });

  it('omits durationMs when not given', () => {
    expect('durationMs' in toResult(mutant('k'), 'Survived', [], [])).toBe(false);
  });
});

// ---- plan: basics -----------------------------------------------------------

describe('plan basics', () => {
  it('returns one entry per mutant in order', () => {
    const ms = [mutant('a'), mutant('b', { ignored: 'disabled' }), mutant('c')];
    const out = plan(input({ mutants: ms, tests: [test('t')] }));
    expect(out.map((e) => e.mutant.key)).toEqual(['a', 'b', 'c']);
  });

  it('marks ignored mutants', () => {
    const e = only(plan(input({ mutants: [mutant('a', { ignored: 'disabled comment' })], tests: [test('t')] })));
    expect(e).toMatchObject({ kind: 'ignored', reason: 'disabled comment' });
  });

  it('without previous or coverage, runs all current tests', () => {
    const e = only(plan(input({ mutants: [mutant('a')], tests: [test('t2', 5), test('t1', 5)] })));
    expect(runTests(e)).toEqual(['t1', 't2']);
  });

  it('uses current coverage when available', () => {
    const e = only(
      plan(input({ mutants: [mutant('a')], tests: [test('t1'), test('t2')], coverage: cov({ a: ['t2'] }) })),
    );
    expect(runTests(e)).toEqual(['t2']);
  });

  it('is noCoverage when coverage has no tests for the key', () => {
    const e = only(plan(input({ mutants: [mutant('a')], tests: [test('t1')], coverage: cov({}) })));
    expect(e.kind).toBe('noCoverage');
  });

  it('is noCoverage when there are no tests at all', () => {
    expect(only(plan(input({ mutants: [mutant('a')], tests: [] }))).kind).toBe('noCoverage');
  });

  it('static mutants run all current tests', () => {
    const e = only(
      plan(
        input({
          mutants: [mutant('a')],
          tests: [test('t1'), test('t2')],
          coverage: cov({}),
          staticKeys: new Set(['a']),
        }),
      ),
    );
    expect(e).toMatchObject({ kind: 'run', isStatic: true, tests: ['t1', 't2'] });
  });

  it('non-static mutants are flagged isStatic false', () => {
    const e = only(plan(input({ mutants: [mutant('a')], tests: [test('t1')] })));
    expect(e).toMatchObject({ kind: 'run', isStatic: false });
  });
});

// ---- plan: timeout ----------------------------------------------------------

describe('plan timeout', () => {
  it('defaults to sum * 1.5 + 5000', () => {
    const e = only(plan(input({ mutants: [mutant('a')], tests: [test('t1', 100), test('t2', 33)] })));
    expect(e).toMatchObject({ kind: 'run', timeoutMs: Math.round(133 * 1.5) + 5000 });
  });

  it('honours options', () => {
    const e = only(
      plan(
        input({
          mutants: [mutant('a')],
          tests: [test('t1', 100)],
          options: { timeoutFactor: 2, timeoutMs: 10 },
        }),
      ),
    );
    expect(e).toMatchObject({ kind: 'run', timeoutMs: 210 });
  });

  it('only counts the selected tests', () => {
    const e = only(
      plan(
        input({
          mutants: [mutant('a')],
          tests: [test('t1', 100), test('t2', 1000)],
          coverage: cov({ a: ['t1'] }),
          options: { timeoutFactor: 1, timeoutMs: 0 },
        }),
      ),
    );
    expect(e).toMatchObject({ kind: 'run', timeoutMs: 100 });
  });
});

// ---- plan: ordering ---------------------------------------------------------

describe('plan ordering', () => {
  it('sorts by duration ascending, ties by id', () => {
    const e = only(
      plan(input({ mutants: [mutant('a')], tests: [test('c', 5), test('b', 5), test('a', 1), test('z', 50)] })),
    );
    expect(runTests(e)).toEqual(['a', 'b', 'c', 'z']);
  });

  it('puts tests with unknown duration last', () => {
    const e = only(
      plan(input({ mutants: [mutant('a')], tests: [test('t1', 50)], coverage: cov({ a: ['ghost', 't1'] }) })),
    );
    expect(runTests(e)).toEqual(['t1', 'ghost']);
  });

  it('previous killers first, then sibling killers by count, then the rest', () => {
    const a = mutant('a');
    const s1 = mutant('s1');
    const s2 = mutant('s2');
    const other = mutant('o', { scope: 'g' });
    const tests = ['fast', 'killer', 'sib1', 'sib2', 'far'].map((id) => test(id, id === 'fast' ? 1 : 100));
    const previous = snapshot(
      [
        // fingerprint change on 'killer' forces a re-run of `a`
        result(a, 'Killed', ['killer'], ['killer']),
        result(s1, 'Killed', ['sib1', 'sib2'], ['sib1', 'sib2']),
        result(s2, 'Killed', ['sib2'], ['sib2']),
        result(other, 'Killed', ['far'], ['far']),
      ],
      tests.map((t) => (t.id === 'killer' ? { ...t, fingerprint: 'old' } : t)),
    );
    const coverage = cov({ a: ['far', 'sib1', 'fast', 'sib2', 'killer'] });
    const e = plan(input({ mutants: [a, s1, s2, other], tests, previous, coverage }))[0]!;
    expect(runTests(e)).toEqual(['killer', 'sib2', 'sib1', 'fast', 'far']);
  });
});

// ---- plan: cache validity ---------------------------------------------------

describe('plan cache validity', () => {
  const a = mutant('a');
  const tests = [test('t1')];
  const prev = (over: Partial<RunSnapshot> = {}) => snapshot([result(a, 'Survived', ['t1'])], tests, over);

  it('reuses with matching tool and env', () => {
    expect(only(plan(input({ mutants: [a], tests, previous: prev() }))).kind).toBe('reuse');
  });

  it('ignores previous on tool version change', () => {
    expect(only(plan(input({ mutants: [a], tests, previous: prev({ toolVersion: 'v0' }) }))).kind).toBe('run');
  });

  it('ignores previous on env change', () => {
    expect(only(plan(input({ mutants: [a], tests, previous: prev({ envHash: 'e0' }) }))).kind).toBe('run');
  });

  it('does not reuse when the scope hash changed', () => {
    const changed = mutant('a', { hash: 'h2' });
    expect(only(plan(input({ mutants: [changed], tests, previous: prev() }))).kind).toBe('run');
  });

  it('does not reuse when the file differs', () => {
    const moved = mutant('a', { file: 'b.ts' });
    expect(only(plan(input({ mutants: [moved], tests, previous: prev() }))).kind).toBe('run');
  });

  it('never reuses a previous Ignored result', () => {
    const previous = snapshot([result(a, 'Ignored', ['t1'])], tests);
    expect(only(plan(input({ mutants: [a], tests, previous }))).kind).toBe('run');
  });

  it('reuse returns the previous result', () => {
    const r = result(a, 'Survived', ['t1']);
    const e = only(plan(input({ mutants: [a], tests, previous: snapshot([r], tests) })));
    expect(e).toEqual({ kind: 'reuse', mutant: a, result: r });
  });
});

// ---- plan: reuse rules ------------------------------------------------------

describe('plan reuse: Killed', () => {
  const a = mutant('a');

  it('reuses when a killer still exists unchanged', () => {
    const tests = [test('k1'), test('k2', 10, 'new')];
    const previous = snapshot([result(a, 'Killed', ['k1', 'k2'], ['k1', 'k2'])], [test('k1'), test('k2')]);
    expect(only(plan(input({ mutants: [a], tests, previous }))).kind).toBe('reuse');
  });

  it('runs (killer first) when the only killer changed', () => {
    const tests = [test('fast', 1), test('k1', 100, 'new')];
    const previous = snapshot([result(a, 'Killed', ['fast', 'k1'], ['k1'])], [test('fast', 1), test('k1', 100)]);
    expect(runTests(only(plan(input({ mutants: [a], tests, previous }))))).toEqual(['k1', 'fast']);
  });

  it('runs when the killer was removed', () => {
    const previous = snapshot([result(a, 'Killed', ['k1', 't2'], ['k1'])], [test('k1'), test('t2')]);
    const e = only(plan(input({ mutants: [a], tests: [test('t2')], previous })));
    expect(runTests(e)).toEqual(['t2']);
  });

  it('runs when the killer is affected by a changed scope it covers', () => {
    const b = mutant('b', { scope: 'g', hash: 'g1' });
    const previous = snapshot(
      [result(a, 'Killed', ['k1'], ['k1']), result(b, 'Survived', ['k1'])],
      [test('k1')],
    );
    const bNow = mutant('b', { scope: 'g', hash: 'g2' });
    expect(plan(input({ mutants: [a, bNow], tests: [test('k1')], previous }))[0]!.kind).toBe('run');
  });

  it('runs when the killer covered a scope that no longer exists', () => {
    const gone = mutant('gone', { scope: 'deleted' });
    const previous = snapshot(
      [result(a, 'Killed', ['k1'], ['k1']), result(gone, 'Survived', ['k1'])],
      [test('k1')],
    );
    expect(only(plan(input({ mutants: [a], tests: [test('k1')], previous }))).kind).toBe('run');
  });
});

describe('plan reuse: Survived', () => {
  const a = mutant('a');
  const tests = [test('t1'), test('t2')];

  it('reuses when covering tests are unaffected', () => {
    const previous = snapshot([result(a, 'Survived', ['t1'])], tests);
    expect(only(plan(input({ mutants: [a], tests, previous, coverage: cov({ a: ['t1'] }) }))).kind).toBe('reuse');
  });

  it('runs when a covering test changed', () => {
    const previous = snapshot([result(a, 'Survived', ['t1'])], [test('t1', 10, 'old'), test('t2')]);
    expect(only(plan(input({ mutants: [a], tests, previous }))).kind).toBe('run');
  });

  it('runs when a covering test was removed', () => {
    const previous = snapshot([result(a, 'Survived', ['t1', 't2'])], tests);
    const e = only(plan(input({ mutants: [a], tests: [test('t2')], previous })));
    expect(runTests(e)).toEqual(['t2']);
  });

  it('runs when a new test now covers it', () => {
    const previous = snapshot([result(a, 'Survived', ['t1'])], tests);
    const e = only(plan(input({ mutants: [a], tests, previous, coverage: cov({ a: ['t1', 't2'] }) })));
    expect(runTests(e)).toEqual(['t1', 't2']);
  });

  it('runs when a covering test depends on a changed scope', () => {
    const b = mutant('b', { scope: 'g', hash: 'g1' });
    const previous = snapshot([result(a, 'Survived', ['t1']), result(b, 'Survived', ['t1'])], tests);
    const bNow = mutant('b', { scope: 'g', hash: 'g2' });
    expect(plan(input({ mutants: [a, bNow], tests, previous }))[0]!.kind).toBe('run');
  });

  it('is not affected by an unrelated test change', () => {
    const previous = snapshot([result(a, 'Survived', ['t1'])], [test('t1'), test('t2', 10, 'old')]);
    expect(only(plan(input({ mutants: [a], tests, previous }))).kind).toBe('reuse');
  });

  it('falls back to previous coveredBy that still exist when no coverage', () => {
    const previous = snapshot([result(a, 'Survived', ['t1', 'gone'])], [...tests, test('gone')]);
    const e = only(plan(input({ mutants: [a], tests, previous })));
    expect(runTests(e)).toEqual(['t1']);
  });
});

describe('plan reuse: NoCoverage', () => {
  const a = mutant('a');
  const tests = [test('t1')];
  const previous = snapshot([result(a, 'NoCoverage')], tests);

  it('reuses when coverage is unavailable', () => {
    expect(only(plan(input({ mutants: [a], tests, previous }))).kind).toBe('reuse');
  });

  it('reuses when coverage is still empty', () => {
    expect(only(plan(input({ mutants: [a], tests, previous, coverage: cov({}) }))).kind).toBe('reuse');
  });

  it('runs when coverage now has tests', () => {
    const e = only(plan(input({ mutants: [a], tests, previous, coverage: cov({ a: ['t1'] }) })));
    expect(runTests(e)).toEqual(['t1']);
  });
});

describe('plan reuse: Timeout / RuntimeError', () => {
  const a = mutant('a');
  const tests = [test('t1')];

  for (const status of ['Timeout', 'RuntimeError'] as const) {
    it(`${status}: reuses when covering tests are unaffected`, () => {
      const previous = snapshot([result(a, status, ['t1'])], tests);
      expect(only(plan(input({ mutants: [a], tests, previous }))).kind).toBe('reuse');
    });

    it(`${status}: runs when a covering test changed`, () => {
      const previous = snapshot([result(a, status, ['t1'])], [test('t1', 10, 'old')]);
      expect(only(plan(input({ mutants: [a], tests, previous }))).kind).toBe('run');
    });
  }
});

describe('plan reuse: static mutants', () => {
  const a = mutant('a');

  it('reuses a static Survived when nothing is affected', () => {
    const tests = [test('t1')];
    const previous = snapshot([result(a, 'Survived')], tests);
    const e = only(plan(input({ mutants: [a], tests, previous, staticKeys: new Set(['a']) })));
    expect(e.kind).toBe('reuse');
  });

  it('re-runs a static Survived when any test is affected', () => {
    const previous = snapshot([result(a, 'Survived')], [test('t1', 10, 'old')]);
    const e = only(plan(input({ mutants: [a], tests: [test('t1')], previous, staticKeys: new Set(['a']) })));
    expect(e).toMatchObject({ kind: 'run', isStatic: true, tests: ['t1'] });
  });
});

// ---- testsToRecollect -------------------------------------------------------

describe('testsToRecollect', () => {
  const a = mutant('a');
  const b = mutant('b', { scope: 'g', hash: 'g1' });
  const base = { toolVersion: 'v1', envHash: 'e1' };

  it('recollects everything without previous', () => {
    expect(testsToRecollect({ ...base, mutants: [a], tests: [test('t1')], previous: undefined })).toEqual({
      all: true,
    });
  });

  it('recollects everything when env changed', () => {
    const previous = snapshot([], [test('t1')], { envHash: 'e0' });
    expect(testsToRecollect({ ...base, mutants: [a], tests: [test('t1')], previous })).toEqual({ all: true });
  });

  it('returns nothing when nothing changed', () => {
    const tests = [test('t1')];
    const previous = snapshot([result(a, 'Survived', ['t1'])], tests);
    expect(testsToRecollect({ ...base, mutants: [a], tests, previous })).toEqual({
      all: false,
      tests: [],
      unknownScopes: [],
    });
  });

  it('includes new and changed tests but not removed ones', () => {
    const previous = snapshot([], [test('same'), test('changed', 10, 'old'), test('removed')]);
    const tests = [test('same'), test('changed'), test('added')];
    const r = testsToRecollect({ ...base, mutants: [], tests, previous });
    expect(r).toEqual({ all: false, tests: ['added', 'changed'], unknownScopes: [] });
  });

  it('includes tests that covered a changed scope', () => {
    const tests = [test('t1'), test('t2'), test('t3')];
    const previous = snapshot([result(a, 'Survived', ['t1']), result(b, 'Killed', ['t2'], ['t2'])], tests);
    const bNow = mutant('b', { scope: 'g', hash: 'g2' });
    const r = testsToRecollect({ ...base, mutants: [a, bNow], tests, previous });
    expect(r).toEqual({ all: false, tests: ['t2'], unknownScopes: [] });
  });

  it('reports scopes with no previous results as unknown', () => {
    const fresh = mutant('n', { file: 'n.ts', scope: 'newFn' });
    const ign = mutant('i', { file: 'n.ts', scope: 'ignoredFn', ignored: 'x' });
    const previous = snapshot([result(a, 'Survived', ['t1'])], [test('t1')]);
    const r = testsToRecollect({ ...base, mutants: [a, fresh, fresh, ign], tests: [test('t1')], previous });
    expect(r).toEqual({ all: false, tests: [], unknownScopes: ['n.ts#newFn'] });
  });
});

// ---- mergeCoverage ----------------------------------------------------------

describe('mergeCoverage', () => {
  const a = mutant('a');

  it('keeps previous coverage for tests not recollected and adds recollected', () => {
    const previous = snapshot([result(a, 'Survived', ['t1', 't2'])], []);
    const merged = mergeCoverage(previous, cov({ a: ['t2', 't3'] }), ['t2', 't3'], [a]);
    expect(merged.get('a')).toEqual(['t1', 't2', 't3']);
  });

  it('drops previous coverage of a recollected test that no longer hits', () => {
    const previous = snapshot([result(a, 'Survived', ['t1', 't2'])], []);
    const merged = mergeCoverage(previous, cov({}), ['t2'], [a]);
    expect(merged.get('a')).toEqual(['t1']);
  });

  it('ignores previous coverage when the scope hash changed', () => {
    const previous = snapshot([result(a, 'Survived', ['t1'])], []);
    const merged = mergeCoverage(previous, cov({ a: ['t2'] }), ['t2'], [mutant('a', { hash: 'h2' })]);
    expect(merged.get('a')).toEqual(['t2']);
  });

  it('works without previous and skips ignored mutants', () => {
    const merged = mergeCoverage(undefined, cov({ a: ['t1'] }), ['t1'], [a, mutant('i', { ignored: 'x' })]);
    expect([...merged]).toEqual([['a', ['t1']]]);
  });

  it('includes covered-by-nobody mutants with an empty list', () => {
    expect(mergeCoverage(undefined, cov({}), [], [a]).get('a')).toEqual([]);
  });
});
