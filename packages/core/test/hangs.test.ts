import { describe, expect, test } from 'vitest';
import { instrument } from '../src/instrument.ts';

const run = (src: string, skipHangs = true) => {
  const { mutants, skipped } = instrument('a.js', src, skipHangs ? { skipHangs: true } : {});
  const show = (m: { mutator: string; original: string; replacement: string }) => `${m.mutator}: ${m.original.replace(/\s+/g, ' ')} -> ${m.replacement}`;
  return {
    placed: mutants.map(show),
    skipped: skipped.filter((s) => s.category === 'timeout').map((s) => `${show(s)} (${s.rule})`),
  };
};

describe('skipHangs', () => {
  test('off by default', () => {
    expect(run('for (let i = 0; i < n; i++) f(i);', false).skipped).toEqual([]);
  });

  test('reversing a for-loop update is skipped as a likely hang', () => {
    const { placed, skipped } = run('for (let i = 0; i < n; i++) f(i);');
    expect(skipped).toEqual(['UpdateOperator: i++ -> i-- (loop-advance)']);
    expect(placed).not.toContain('UpdateOperator: i++ -> i--');
  });

  test('an assignment update and each update of a sequence count too', () => {
    expect(run('for (let i = 0, j = n; i < j; i += 2, j--) f(i);').skipped).toEqual([
      'AssignmentOperator: i += 2 -> i -= 2 (loop-advance)',
      'UpdateOperator: j-- -> j++ (loop-advance)',
    ]);
  });

  test('an update outside a loop header is kept', () => {
    expect(run('let i = 0; i++; while (i < n) { i++; }').skipped).toEqual(['BlockStatement: { i++; } -> {} (loop-body)']);
  });

  test('emptying a while / do-while body, or a for body without an update, is skipped', () => {
    expect(run('while (a < b) { a++; }').skipped).toEqual(['BlockStatement: { a++; } -> {} (loop-body)']);
    expect(run('do { a++; } while (a < b);').skipped).toEqual(['BlockStatement: { a++; } -> {} (loop-body)']);
    expect(run('for (; a < b; ) { a++; }').skipped).toEqual(['BlockStatement: { a++; } -> {} (loop-body)']);
  });

  test('emptying a for body with an update is kept: the loop still ends', () => {
    expect(run('for (let i = 0; i < n; i++) { f(i); }').placed).toContain('BlockStatement: { f(i); } -> {}');
  });
});
