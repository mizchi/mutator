import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Mutant } from '@mizchi/mutator-core';
import type { AgentReport } from '../src/agent-report.ts';
import { formatSimplify, removalKind, simplifyCandidates } from '../src/simplify.ts';
import type { Report, ReportEntry } from '../src/run.ts';

const scope = (id: string, from: number, to: number) => ({ id, hash: 'h', range: { start: 0, end: 1 }, location: { start: { line: from, column: 0 }, end: { line: to, column: 1 } } });

let next = 0;
const entry = (mutator: string, original: string, replacement: string, status: ReportEntry['status'] = 'Survived', extra: Partial<ReportEntry> & { line?: number; file?: string; scopeId?: string } = {}): ReportEntry => {
  const { line = 2, file = '/p/src/a.ts', scopeId = 'normalize', ...rest } = extra;
  const key = `k${next++}`;
  return {
    mutant: { key, file, mutator, range: { start: 0, end: 1 }, location: { start: { line, column: 2 }, end: { line, column: 3 } }, original, replacement, scope: scope(scopeId, 1, 10) } as Mutant,
    status,
    source: 'run',
    killedBy: [],
    coveredBy: ['a.test.ts#x'],
    ...rest,
  };
};

const report = (entries: ReportEntry[], extra: Partial<Report> = {}): Report => ({ entries, executed: entries.length, dryRunFiles: [], scope: 'all', score: 0, durationMs: 1, notRun: { sampled: 0, budget: 0 }, ...extra });

describe('removalKind', () => {
  test('statement removal, emptied block, forced condition, optional chaining and dropped method calls are removals', () => {
    expect(removalKind({ mutator: 'CallExpression', original: 'cache.clear();', replacement: ';' })).toBe('statement');
    expect(removalKind({ mutator: 'BlockStatement', original: '{ return x; }', replacement: '{}' })).toBe('block');
    expect(removalKind({ mutator: 'ConditionalExpression', original: 'x == null', replacement: 'false' })).toBe('condition');
    expect(removalKind({ mutator: 'ConditionalExpression', original: 'x == null', replacement: 'true' })).toBe('condition');
    expect(removalKind({ mutator: 'OptionalChaining', original: '?.', replacement: '.' })).toBe('optionalChain');
    expect(removalKind({ mutator: 'OptionalChaining', original: '?.', replacement: '' })).toBe('optionalChain');
    expect(removalKind({ mutator: 'MethodExpression', original: 's.trim()', replacement: 's' })).toBe('methodCall');
  });

  test('mutants that change a value instead of removing code are not', () => {
    expect(removalKind({ mutator: 'MethodExpression', original: 'endsWith', replacement: 'startsWith' })).toBeUndefined();
    expect(removalKind({ mutator: 'EqualityOperator', original: 'a < b', replacement: 'a <= b' })).toBeUndefined();
    expect(removalKind({ mutator: 'ArrowFunction', original: 'x + 1', replacement: 'undefined' })).toBeUndefined();
    expect(removalKind({ mutator: 'FnValue', original: '{ return x; }', replacement: '{ return 0; }' })).toBeUndefined();
    expect(removalKind({ mutator: 'StringLiteral', original: '"a"', replacement: '""' })).toBeUndefined();
  });
});

describe('simplifyCandidates', () => {
  test('keeps covered survivors of removals, grouped by enclosing function in source order', () => {
    const guard = entry('ConditionalExpression', 'x == null', 'false', 'Survived', { line: 3 });
    const call = entry('CallExpression', 'log(x);', ';', 'Survived', { line: 2 });
    const other = entry('BlockStatement', '{ y++; }', '{}', 'Survived', { line: 12, scopeId: 'other' });
    const groups = simplifyCandidates(
      report([
        guard,
        call,
        other,
        entry('BlockStatement', '{ a(); }', '{}', 'NoCoverage'),
        entry('BlockStatement', '{ a(); }', '{}', 'Killed'),
        entry('BlockStatement', '{ a(); }', '{}', 'Ignored', { accepted: 'needed for perf' }),
        entry('BlockStatement', '{ a(); }', '{}', 'Ignored', { reason: 'equivalent: x' }),
        entry('EqualityOperator', 'a < b', 'a <= b'),
      ]),
      '/p',
    );
    expect(groups).toEqual([
      {
        file: 'src/a.ts',
        scope: 'normalize',
        startLine: 1,
        endLine: 10,
        candidates: [
          { key: call.mutant.key, kind: 'statement', line: 2, column: 3, mutator: 'CallExpression', original: 'log(x);', replacement: ';' },
          { key: guard.mutant.key, kind: 'condition', line: 3, column: 3, mutator: 'ConditionalExpression', original: 'x == null', replacement: 'false' },
        ],
      },
      expect.objectContaining({ scope: 'other', candidates: [expect.objectContaining({ key: other.mutant.key, kind: 'block' })] }),
    ]);
  });

  test('marks survivors no test infects, and leaves out mutants a child process may observe', () => {
    const notInfected = entry('ConditionalExpression', 'x == null', 'false', 'Survived', { reason: 'notInfected' });
    const spawned = entry('CallExpression', 'run();', ';');
    const [group] = simplifyCandidates(report([notInfected, spawned], { childProcessMutants: [spawned.mutant.key] }), '/p');
    expect(group!.candidates).toEqual([expect.objectContaining({ key: notInfected.mutant.key, notInfected: true })]);
  });

  test('with --since, only the reported mutants', () => {
    const inDiff = entry('CallExpression', 'a();', ';', 'Survived', { focus: 'diff' });
    const context = entry('CallExpression', 'b();', ';');
    const groups = simplifyCandidates(report([inDiff, context], { scope: 'diff' }), '/p');
    expect(groups.flatMap((g) => g.candidates.map((c) => c.key))).toEqual([inDiff.mutant.key]);
  });
});

describe('formatSimplify', () => {
  test('frames candidates as possibly unnecessary code, per function, with the removed code', () => {
    const text = formatSimplify(
      simplifyCandidates(
        report([
          entry('ConditionalExpression', 'x == null', 'false', 'Survived', { line: 3 }),
          entry('CallExpression', 'cache.clear();', ';', 'Survived', { line: 4 }),
          entry('OptionalChaining', '?.', '.', 'Survived', { line: 5, reason: 'notInfected' }),
          entry('BlockStatement', '{\n    return   fallback;\n  }', '{}', 'Survived', { line: 2, file: '/p/src/b.ts', scopeId: 'Cache.get' }),
          entry('MethodExpression', 'name.trim()', 'name', 'Survived', { line: 6 }),
        ]),
        '/p',
      ),
    );
    expect(text).toBe(
      [
        'may be unnecessary - no test observes the removal of this code (5 candidates in 2 functions):',
        'each is also listed as a test gap in the summary; remove the code, or add a test that needs it.',
        '',
        'src/a.ts  normalize (lines 1-10)',
        '  3:3  condition always false  x == null',
        '  4:3  statement removed       cache.clear();',
        '  5:3  ?. replaced by .        ?.  (no test reaches it with a value it changes)',
        '  6:3  call dropped            .trim()',
        '',
        'src/b.ts  Cache.get (lines 1-10)',
        '  2:3  block emptied           { return fallback; }',
      ].join('\n'),
    );
  });

  test('shows the source line for an optional chain, whose removed text alone says little', () => {
    const groups = simplifyCandidates(report([entry('OptionalChaining', '?.', '.', 'Survived', { line: 2 })]), '/p', () => ['function f(user) {', '  return user?.name;', '}']);
    expect(groups[0]!.candidates[0]!.code).toBe('return user?.name;');
    expect(formatSimplify(groups)).toContain('  2:3  ?. replaced by .        return user?.name;');
  });

  test('says so when there is nothing to simplify', () => {
    expect(formatSimplify([])).toBe('may be unnecessary - no candidates: every removal is observed by a test, or not covered');
  });
});

describe('--reporter simplify', () => {
  const cli = join(import.meta.dirname, '../src/cli.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  test('lists a redundant guard as possibly unnecessary, apart from the summary, without failing the run', () => {
    // Inside the workspace so the fixture resolves `vitest` from the root node_modules.
    const root = join(import.meta.dirname, '../../../.tmp', `simplify-${process.pid}`);
    cpSync(join(import.meta.dirname, 'fixtures/simplify'), root, { recursive: true });
    try {
      const both = run('--root', root, '-j', '1', '--reporter', 'text', '--reporter', 'simplify');
      expect(both.status, both.stderr).toBe(0);
      const [summary, simplify = ''] = both.stdout.split('\nmay be unnecessary');
      // The same mutant is a test gap in the summary ...
      expect(summary).toMatch(/not detected - tests run it, but none fails:\n  src\/label\.js:3:7 +Survived +name\.length === 0 -> false/);
      // ... and a candidate in the simplify report, under its function.
      expect(simplify).toContain('src/label.js  label (lines 1-5)');
      expect(simplify).toMatch(/\n  3:7 +condition always false +name\.length === 0\n/);
      expect(simplify).not.toContain('sign');

      const textOnly = run('--root', root, '-j', '1');
      expect(textOnly.stdout).not.toContain('may be unnecessary');

      const agent = JSON.parse(run('--root', root, '-j', '1', '--reporter', 'agent').stdout) as AgentReport;
      expect(agent.gaps.filter((g) => g.simplify).map((g) => [g.line, g.simplify])).toEqual([[3, 'condition']]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
