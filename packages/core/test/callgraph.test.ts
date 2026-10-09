import { describe, expect, test } from 'vitest';
import { buildCallGraph, relatedScopes } from '../src/callgraph.ts';
import { instrument } from '../src/instrument.ts';

const source = (file: string, code: string) => ({ file, ...instrument(file, code) });

describe('call extraction', () => {
  test('records calls per scope and imports', () => {
    const r = instrument('/p/a.ts', [
      "import { helper as h, other } from './b.ts';",
      "import * as ns from './c.ts';",
      'export function f(x: number) { return h(x) + ns.g(x) + inner(x); function inner(y: number) { return y; } }',
      'class K { m() { return this.n(); } n() { return 1; } }',
      'const obj = { run() { return other(); } };',
    ].join('\n'));
    expect(r.imports).toEqual([
      { local: 'h', imported: 'helper', source: './b.ts' },
      { local: 'other', imported: 'other', source: './b.ts' },
      { local: 'ns', imported: '*', source: './c.ts' },
    ]);
    const callsOf = (scope: string) => r.calls.filter((c) => c.scope === scope).map((c) => c.callee).sort();
    expect(callsOf('f')).toEqual(['h', 'inner', 'ns.g']);
    expect(callsOf('K.m')).toEqual(['this.n']);
    expect(callsOf('obj.run')).toEqual(['other']);
  });
});

describe('call graph', () => {
  const files = [
    source('/p/a.ts', "import { helper } from './b.ts';\nexport function top(x: number) { return mid(x) + 1; }\nfunction mid(x: number) { return helper(x) * 2; }\nexport function lonely(x: number) { return x - 1; }\n"),
    source('/p/b.ts', 'export function helper(x: number) { return x + 3; }\nexport function unused(x: number) { return x; }\n'),
  ];
  const resolve = (from: string, spec: string) => (spec === './b.ts' ? '/p/b.ts' : undefined);
  const graph = buildCallGraph(files, resolve);

  test('resolves same-file and imported callees', () => {
    expect([...(graph.get('/p/a.ts#top') ?? [])]).toEqual(['/p/a.ts#mid']);
    expect([...(graph.get('/p/a.ts#mid') ?? [])]).toEqual(['/p/b.ts#helper']);
  });

  test('relation is transitive reachability in either direction', () => {
    const related = relatedScopes(graph);
    expect(related('/p/a.ts#top', '/p/b.ts#helper')).toBe(true);
    expect(related('/p/b.ts#helper', '/p/a.ts#top')).toBe(true);
    expect(related('/p/a.ts#lonely', '/p/b.ts#helper')).toBe(false);
    expect(related('/p/b.ts#unused', '/p/a.ts#mid')).toBe(false);
    expect(related('/p/a.ts#mid', '/p/a.ts#mid')).toBe(true);
  });

  test('top-level code is related to everything in its file', () => {
    const related = relatedScopes(graph);
    expect(related('/p/a.ts#<top:abc>', '/p/a.ts#lonely')).toBe(true);
    expect(related('/p/a.ts#lonely', '/p/a.ts#<top:abc>')).toBe(true);
  });
});
