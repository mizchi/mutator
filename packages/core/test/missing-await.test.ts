import { describe, expect, test } from 'vitest';
import { instrument } from '../src/instrument.ts';

const run = (src: string, enabled = true) => {
  const { mutants, skipped } = instrument('a.js', src, enabled ? {} : { excludedMutators: ['MissingAwait'] });
  return {
    placed: mutants.filter((m) => m.mutator === 'MissingAwait').map((m) => `${m.original} -> ${m.replacement}`),
    skipped: skipped.filter((s) => s.mutator === 'MissingAwait').map((s) => `${s.original} -> ${s.replacement} (${s.rule}, ${s.category})`),
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
    expect(run('async function f() { return await g(); }')).toEqual({ placed: [], skipped: ['await g() -> g() (awaited-by-caller, equivalent)'] });
    expect(run('const f = async () => await g();')).toEqual({ placed: [], skipped: ['await g() -> g() (awaited-by-caller, equivalent)'] });
  });

  test('`return await` inside try / catch / finally is kept: a rejection escapes the handler', () => {
    expect(run('async function f() { try { return await g(); } catch { return 0; } }').placed).toEqual(['await g() -> g()']);
    expect(run('async function f() { try { x(); } finally { return await g(); } }').placed).toEqual([]);
  });

  test('awaiting a literal is equivalent: it settles to the same value', () => {
    expect(run('async function f() { const x = await 1; return x; }').skipped).toEqual(['await 1 -> 1 (settled-value, equivalent)']);
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
