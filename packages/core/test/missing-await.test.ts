import { describe, expect, test } from 'vitest';
import { instrument } from '../src/instrument.ts';

const run = (src: string, enabled = true) => {
  const { mutants, skipped } = instrument('a.js', src, enabled ? {} : { excludedMutators: ['MissingAwait'] });
  return {
    placed: mutants.filter((m) => m.mutator === 'MissingAwait').map((m) => `${m.original} -> ${m.replacement}`),
    skipped: skipped.filter((s) => s.mutator === 'MissingAwait').map((s) => `${s.original} -> ${s.replacement} (${s.rule}, ${s.category}${s.heuristic ? ', heuristic' : ''})`),
  };
};

describe('MissingAwait', () => {
  test('is on by default; --exclude-mutator turns it off', () => {
    expect(run('async function f() { await g(); }', false).placed).toEqual([]);
  });

  test('drops an await', () => {
    expect(run('async function f() { const x = await g(); return x; }').placed).toEqual(['await g() -> g()']);
    expect(run('async function f() { await g(); h(); }').placed).toEqual(['await g() -> g()']);
  });

  test('`return await` outside try is equivalent: the caller awaits the promise anyway', () => {
    expect(run('async function f() { return await g(); }')).toEqual({ placed: [], skipped: ['await g() -> g() (awaited-by-caller, equivalent, heuristic)'] });
    expect(run('const f = async () => await g();')).toEqual({ placed: [], skipped: ['await g() -> g() (awaited-by-caller, equivalent, heuristic)'] });
  });

  test('`return await` inside try / catch / finally is kept: a rejection escapes the handler', () => {
    expect(run('async function f() { try { return await g(); } catch { return 0; } }').placed).toEqual(['await g() -> g()']);
    expect(run('async function f() { try { x(); } finally { return await g(); } }').placed).toEqual([]);
  });

  test('awaiting a literal or an object is a mutant: await yields a tick, and an object can be a thenable', () => {
    expect(run('async function f() { const x = await 1; return x; }').placed).toEqual(['await 1 -> 1']);
    expect(run('async function f() { const x = await { then(r) { r(42); } }; return x; }').placed).toEqual(['await { then(r) { r(42); } } -> { then(r) { r(42); } }']);
  });

  test('keeps parentheses of the operand and needs no new ones', () => {
    expect(run('async function f() { return (await g()).x; }').placed).toEqual(['await g() -> g()']);
    expect(run('async function f() { await (a, b); }').placed).toEqual(['await (a, b) -> (a, b)']);
  });
});

describe('MethodExpression swaps', () => {
  test('padStart <-> padEnd (rounding methods are the numeric plugin\'s)', () => {
    const { mutants } = instrument('a.js', 'x = Math.floor(a) + s.padStart(3);');
    expect(mutants.filter((m) => m.mutator === 'MethodExpression').map((m) => `${m.original} -> ${m.replacement}`)).toEqual(['padStart -> padEnd']);
  });
});
