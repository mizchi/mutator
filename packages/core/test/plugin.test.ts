import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { applyMutant, instrument } from '../src/instrument.ts';
import { defineMutator, definePlugin } from '../src/plugin.ts';

// Replace `a ?? b` with `a` (drop the fallback).
const dropFallback = defineMutator({
  name: 'DropFallback',
  visit(node, ctx) {
    if (node.type !== 'LogicalExpression' || node.operator !== '??') return;
    return [{ replacement: ctx.text(node.left) }];
  },
});

// Swap `Math.floor` <-> `Math.ceil` by editing only the property name.
const roundingFlip = defineMutator({
  name: 'RoundingFlip',
  visit(node) {
    if (node.type !== 'MemberExpression' || node.object.type !== 'Identifier' || node.object.name !== 'Math') return;
    const flip: Record<string, string> = { floor: 'ceil', ceil: 'floor' };
    const to = node.property.type === 'Identifier' ? flip[node.property.name] : undefined;
    return to ? [{ range: { start: node.property.start, end: node.property.end }, replacement: to }] : undefined;
  },
});

const evaluate = (code: string, active: string | null) => {
  const context = vm.createContext({ exports: {}, __mutator__: { active, cov: { static: {}, perTest: {} }, testId: null, hits: 0, hitLimit: 1e6 } });
  vm.runInContext(code, context);
  return JSON.parse(JSON.stringify(context.exports));
};

describe('custom mutators', () => {
  const src = 'const opt = undefined; exports.r = [opt ?? 5, Math.floor(2.5), 1 + 1];';

  test('are found, named and placed like built-in mutators', () => {
    const { code, mutants } = instrument('a.js', src, { mutators: [dropFallback, roundingFlip] });
    const custom = mutants.filter((m) => m.mutator === 'DropFallback' || m.mutator === 'RoundingFlip');
    expect(custom.map((m) => `${m.mutator}: ${m.original} -> ${m.replacement}`)).toEqual(['DropFallback: opt ?? 5 -> opt', 'RoundingFlip: floor -> ceil']);
    for (const m of custom) expect(evaluate(code, m.key)).toEqual(evaluate(applyMutant(src, m), null));
    expect(evaluate(code, null)).toEqual(evaluate(src, null));
  });

  test('built-in mutators keep running next to plugins (zero config stays the default)', () => {
    const withPlugins = instrument('a.js', src, { mutators: [dropFallback] }).mutants.filter((m) => m.mutator !== 'DropFallback');
    expect(withPlugins.map((m) => m.key)).toEqual(instrument('a.js', src).mutants.map((m) => m.key));
  });

  test('can be excluded by name, like built-ins', () => {
    const { mutants } = instrument('a.js', src, { mutators: [dropFallback], excludedMutators: ['DropFallback', 'ArithmeticOperator'] });
    expect(mutants.some((m) => m.mutator === 'DropFallback' || m.mutator === 'ArithmeticOperator')).toBe(false);
  });

  test('honour disable comments and arid suppression', () => {
    const { mutants } = instrument('a.js', '// mutator-disable-next-line DropFallback\nx = a ?? b;\nconsole.log(c ?? d);', { mutators: [dropFallback] });
    expect(mutants.filter((m) => m.mutator === 'DropFallback').map((m) => m.ignored)).toEqual(['disabled', 'arid: logging']);
  });

  test('a replacement outside the visited node is rejected with the mutator name', () => {
    const bad = defineMutator({ name: 'OutOfRange', visit: (node) => (node.type === 'Literal' ? [{ range: { start: 0, end: 1 }, replacement: 'x' }] : undefined) });
    expect(() => instrument('a.js', 'y = 1;', { mutators: [bad] })).toThrow(/OutOfRange/);
  });

  test('a replacement that breaks the syntax is rejected with the mutator name', () => {
    const broken = defineMutator({ name: 'Broken', visit: (node) => (node.type === 'Literal' ? [{ replacement: '1 +' }] : undefined) });
    expect(() => instrument('a.js', 'y = 1;', { mutators: [broken] })).toThrow(/Broken/);
  });

  test('a mutator throwing is reported with its name', () => {
    const throwing = defineMutator({ name: 'Throws', visit: () => { throw new Error('boom'); } });
    expect(() => instrument('a.js', 'y = 1;', { mutators: [throwing] })).toThrow(/Throws.*boom/);
  });

  test('names must not shadow built-in mutators', () => {
    expect(() => instrument('a.js', 'y = 1;', { mutators: [defineMutator({ name: 'StringLiteral', visit: () => undefined })] })).toThrow(/built-in/);
  });

  test('definePlugin bundles mutators and arid callees', () => {
    const plugin = definePlugin({ name: 'my-plugin', mutators: [dropFallback], aridCallees: ['metrics.*'] });
    expect(plugin).toEqual({ name: 'my-plugin', mutators: [dropFallback], aridCallees: ['metrics.*'] });
  });
});
