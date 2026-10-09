import { describe, expect, test } from 'vitest';
import { instrument } from '../src/instrument.ts';

const run = (src: string, options = {}) => {
  const { mutants } = instrument('a.js', src, options);
  const label = (m: (typeof mutants)[number]) => `${m.mutator}: ${m.original.replace(/\s+/g, ' ')} -> ${m.replacement}`;
  return {
    arid: mutants.filter((m) => m.ignored?.startsWith('arid')).map(label),
    placed: mutants.filter((m) => !m.ignored).map(label),
  };
};

describe('arid node suppression', () => {
  test('mutants inside logging calls are arid', () => {
    const { arid, placed } = run('function f(a) { console.log("value", a + 1); return a * 2; }');
    expect(arid).toEqual(expect.arrayContaining(['StringLiteral: "value" -> ""', 'ArithmeticOperator: a + 1 -> a - 1']));
    expect(placed).toContain('ArithmeticOperator: a * 2 -> a / 2');
  });

  test('removing a logging statement is arid', () => {
    const { arid } = run('function f(x) { logger.info(x); return 1; }');
    expect(arid).toContain('CallExpression: logger.info(x); -> ;');
  });

  test('a block or if that only logs is arid (compound rule)', () => {
    const { arid, placed } = run('function f(a) { if (a > 1) { this.logger.debug("big"); } return a; }');
    expect(arid).toEqual(expect.arrayContaining(['ConditionalExpression: a > 1 -> true', 'EqualityOperator: a > 1 -> a >= 1', 'BlockStatement: { this.logger.debug("big"); } -> {}']));
    expect(placed.some((p) => p.startsWith('BlockStatement: { if'))).toBe(true);
  });

  test('a block mixing logging and logic is not arid', () => {
    const { placed } = run('function f(a) { if (a > 1) { console.warn("big"); return 0; } return a; }');
    expect(placed).toContain('ConditionalExpression: a > 1 -> true');
  });

  test('member calls named debug/trace are arid, other calls are not', () => {
    const { arid, placed } = run('function f(d, a) { d.debug(a + 1); d.trace(a + 2); d.send(a + 3); }');
    expect(arid).toEqual(expect.arrayContaining(['ArithmeticOperator: a + 1 -> a - 1', 'ArithmeticOperator: a + 2 -> a - 2']));
    expect(placed).toContain('ArithmeticOperator: a + 3 -> a - 3');
  });

  test('can be disabled or extended', () => {
    expect(run('function f(a) { console.log(a + 1); }', { arid: false }).arid).toEqual([]);
    expect(run('function f(a) { metrics.count(a + 1); }', { arid: { callees: ['metrics.*'] } }).arid).toContain('ArithmeticOperator: a + 1 -> a - 1');
  });

  test('arid mutants are not placed', () => {
    expect(instrument('a.js', 'function f(a) { console.log(a + 1); }').code).not.toContain('__mutator_act');
  });
});
