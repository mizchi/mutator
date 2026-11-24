import { describe, expect, test } from 'vitest';
import { instrument } from '../src/instrument.ts';

const run = (src: string, enabled: string[] = ['ArrayElement', 'ObjectProperty']) => {
  const { mutants, skipped } = instrument('a.js', src, { enabledMutators: enabled });
  return {
    placed: mutants.filter((m) => m.mutator === 'ArrayElement' || m.mutator === 'ObjectProperty').map((m) => `${m.mutator}: ${m.original} -> ${m.replacement}`),
    duplicates: skipped.filter((s) => s.rule === 'same-edit').map((s) => `${s.mutator}: ${s.replacement}`),
  };
};

describe('ArrayElement / ObjectProperty (opt-in)', () => {
  test('off unless enabled', () => {
    expect(run('x = [a, b];', []).placed).toEqual([]);
  });

  test('removes one array element at a time', () => {
    expect(run('x = [a, b, c];').placed).toEqual(['ArrayElement: [a, b, c] -> [b, c]', 'ArrayElement: [a, b, c] -> [a, c]', 'ArrayElement: [a, b, c] -> [a, b]']);
  });

  test('removes one property at a time, spreads and methods included', () => {
    expect(run('x = { a: 1, ...rest, m() { return 1; } };').placed).toEqual([
      'ObjectProperty: { a: 1, ...rest, m() { return 1; } } -> { ...rest, m() { return 1; } }',
      'ObjectProperty: { a: 1, ...rest, m() { return 1; } } -> { a: 1, m() { return 1; } }',
      'ObjectProperty: { a: 1, ...rest, m() { return 1; } } -> { a: 1, ...rest }',
    ]);
  });

  test('a single element or property is the literal mutator\'s emptying, so it yields', () => {
    expect(run('x = [a]; y = { a: 1 };')).toEqual({ placed: [], duplicates: ['ArrayElement: []', 'ObjectProperty: {}'] });
  });

  test('arrays with holes and literals over 16 entries are left alone', () => {
    expect(run('x = [a, , b];').placed).toEqual([]);
    expect(run(`x = [${Array.from({ length: 17 }, (_, i) => i).join(', ')}];`).placed).toEqual([]);
  });

  test('the mutated literal keeps the parentheses around it', () => {
    expect(run('const f = () => ({ a: 1, b: 2 });').placed).toEqual(['ObjectProperty: { a: 1, b: 2 } -> { b: 2 }', 'ObjectProperty: { a: 1, b: 2 } -> { a: 1 }']);
  });
});

describe('RegexFlag (opt-in)', () => {
  const flags = (src: string, on = true) =>
    instrument('a.js', src, on ? { enabledMutators: ['RegexFlag'] } : {}).mutants.filter((m) => m.mutator === 'RegexFlag').map((m) => `${m.original} -> ${m.replacement}`);

  test('off unless enabled', () => {
    expect(flags('x = /a/gi;', false)).toEqual([]);
  });

  test('removes one flag at a time', () => {
    expect(flags('x = /a/gim;')).toEqual(['/a/gim -> /a/im', '/a/gim -> /a/gm', '/a/gim -> /a/gi']);
  });

  test('removing `u` is a mutant too: without it `\\p{L}` matches the text "p{L}"', () => {
    expect(flags(String.raw`x = /\p{L}/gu;`)).toEqual([String.raw`/\p{L}/gu -> /\p{L}/u`, String.raw`/\p{L}/gu -> /\p{L}/g`]);
  });
});
