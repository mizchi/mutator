import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createSourceCoverageMapper, type ScriptCoverage } from '../src/source-coverage.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mutator-source-coverage-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const source = [
  'function called(value) {',
  '  function nested() { return value; }',
  '  return value;',
  '}',
  'function unused(value) {',
  '  return value;',
  '}',
  'called(globalThis.input);',
].join('\n');

function entry(original = source): ScriptCoverage {
  // Two generated lines precede the original. Mapping every line back tests the
  // generated/original coordinate change without depending on a bundler in unit tests.
  const map = { version: 3, sources: ['app.js'], sourcesContent: [original], names: [], mappings: ';;AAAA;' + Array(7).fill('AACA').join(';') };
  const generated = '// generated header\n// another line\n' + source;
  const functions = [
    { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: generated.length, count: 1 }] },
    { functionName: 'called', isBlockCoverage: true, ranges: [{ startOffset: generated.indexOf('function called'), endOffset: generated.indexOf('\nfunction unused'), count: 1 }] },
    { functionName: 'nested', isBlockCoverage: false, ranges: [{ startOffset: generated.indexOf('function nested'), endOffset: generated.indexOf('  return value;\n}'), count: 0 }] },
    { functionName: 'unused', isBlockCoverage: false, ranges: [{ startOffset: generated.indexOf('function unused'), endOffset: generated.lastIndexOf('\ncalled('), count: 0 }] },
  ];
  return { url: 'http://localhost:4173/app.js', source: generated + '\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64'), functions };
}

test('maps executed generated ranges back to original scopes, including scopes without mutants', () => {
  const target = join(root, 'app.js');
  writeFileSync(target, source);
  const mapped = createSourceCoverageMapper({ root, targets: [target] })([entry()]);
  expect(mapped.complete).toBe(true);
  expect(mapped.scopes).toContain('app.js#called');
  expect(mapped.scopes).not.toContain('app.js#called>nested');
  expect(mapped.scopes).not.toContain('app.js#unused');
  // Module-level dependencies already have a conservative fallback. Repeating
  // every export declaration for every E2E makes the scope index needlessly huge.
  expect(mapped.scopes.some((scope) => scope.includes('#<top'))).toBe(false);
});

test('rejects a stale map instead of attributing old generated code to the current source', () => {
  const target = join(root, 'app.js');
  writeFileSync(target, source);
  expect(createSourceCoverageMapper({ root, targets: [target] })([entry(source + '\n// old')])).toMatchObject({ complete: false, scopes: [] });
});

test('a target without a usable inline map is incomplete; unrelated scripts are ignored', () => {
  const target = join(root, 'app.js');
  writeFileSync(target, source);
  const map = createSourceCoverageMapper({ root, targets: [target] });
  expect(map([{ ...entry(), source }])).toMatchObject({ complete: false, scopes: [] });
  expect(map([{ ...entry(), url: 'http://localhost:4173/node_modules/lib.js', source }])).toEqual({ complete: true, scopes: [] });
});

test('handles several scripts and deduplicates observations without sharing test hits', () => {
  const target = join(root, 'app.js');
  writeFileSync(target, source);
  const map = createSourceCoverageMapper({ root, targets: [target] });
  const first = map([entry(), entry()]);
  expect(first.scopes.filter((s) => s === 'app.js#called')).toHaveLength(1);
  expect(map([])).toEqual({ complete: true, scopes: [] });
});

test('uses the source index of each mapping in a bundle with several original sources', () => {
  const a = join(root, 'app.js');
  const b = join(root, 'other.js');
  writeFileSync(a, source);
  writeFileSync(b, source);
  const script = entry();
  const marker = 'data:application/json;base64,';
  const at = script.source!.indexOf(marker);
  const map = JSON.parse(Buffer.from(script.source!.slice(at + marker.length), 'base64').toString());
  map.sources.push('other.js');
  map.sourcesContent.push(source);
  map.mappings = map.mappings.replace('AAAA', 'ACAA');
  script.source = script.source!.slice(0, at) + 'data:application/json,' + encodeURIComponent(JSON.stringify(map));
  const mapped = createSourceCoverageMapper({ root, targets: [a, b] })([script]);
  expect(mapped).toEqual({ complete: true, scopes: ['other.js#called'] });
});
