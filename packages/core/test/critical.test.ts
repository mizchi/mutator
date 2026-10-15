import { describe, expect, test } from 'vitest';
import { instrument } from '../src/instrument.ts';

/** The arithmetic mutants marked critical. */
const critical = (src: string) =>
  instrument('a.ts', src)
    .mutants.filter((m) => m.critical && m.mutator === 'ArithmeticOperator')
    .map((m) => `${m.original} -> ${m.replacement}`);

describe('// mutator-critical', () => {
  test('marks every mutant of the function declared on the next line, nested functions included', () => {
    const src = [
      'export function free(a) { return a + 1; }',
      '// mutator-critical',
      'export function charge(a, b) {',
      '  const f = () => a * b;',
      '  return f();',
      '}',
      'function after(a) { return a - 1; }',
    ].join('\n');
    expect(critical(src)).toEqual(['a * b -> a / b']);
    const marked = instrument('a.ts', src).mutants.filter((m) => m.critical);
    expect(marked.every((m) => m.location.start.line >= 3 && m.location.end.line <= 6)).toBe(true);
    expect(marked.length).toBeGreaterThan(1);
  });

  test('arrow functions in a variable declaration, classes and methods', () => {
    expect(critical('// mutator-critical\nconst f = (a) => a + 1;\nconst g = (a) => a - 1;')).toEqual(['a + 1 -> a - 1']);
    expect(critical('// mutator-critical\nclass K { m(a) { return a + 1; } }\nconst g = (a) => a - 1;')).toEqual(['a + 1 -> a - 1']);
    expect(critical('class K {\n  // mutator-critical\n  m(a) { return a + 1; }\n  n(a) { return a - 1; }\n}')).toEqual(['a + 1 -> a - 1']);
  });

  test('a comment not followed by a function or class marks nothing', () => {
    expect(critical('// mutator-critical\nx = 1 + 1;\nfunction f(a) { return a - 1; }')).toEqual([]);
  });

  test('does not change mutant keys', () => {
    const src = 'function f(a) { return a + 1; }';
    const plain = instrument('a.ts', src).mutants.map((m) => m.key);
    expect(instrument('a.ts', `// mutator-critical\n${src}`).mutants.map((m) => m.key)).toEqual(plain);
  });
});
