// Positive observations from V8's generated ranges, remapped to the original
// source scopes. Missing/stale maps never become evidence of non-execution.
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Profiler } from 'node:inspector';
import { TraceMap, decodedMappings } from '@jridgewell/trace-mapping';
import { type Scope, instrument, isTopLevelScope } from '@mizchi/mutator-core';

export interface ScriptCoverage {
  url: string;
  source?: string;
  functions: Profiler.FunctionCoverage[];
}

export interface SourceObservation {
  /** Original function scopes: `${relative source file}#${scopeId}`. */
  scopes: string[];
  /** False means that absence from `scopes` cannot be used to exclude tests. */
  complete: boolean;
}

interface ScopeNode { scope: Scope; children: ScopeNode[] }
interface SourceInfo { source: string; lines: number[]; scopes: ScopeNode[] }
interface Point { offset: number; scope: string }

const starts = (source: string) => [0, ...Array.from(source.matchAll(/\n/g), (m) => m.index + 1)];

function tree(scopes: readonly Scope[]): ScopeNode[] {
  const roots: ScopeNode[] = [];
  const stack: ScopeNode[] = [];
  for (const scope of [...scopes].sort((a, b) => a.range.start - b.range.start || b.range.end - a.range.end)) {
    while (stack.length && stack.at(-1)!.scope.range.end <= scope.range.start) stack.pop();
    const node = { scope, children: [] };
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  return roots;
}

function scopeAt(nodes: readonly ScopeNode[], offset: number): Scope | undefined {
  let lo = 0, hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (nodes[mid]!.scope.range.start <= offset) lo = mid + 1;
    else hi = mid;
  }
  const node = nodes[lo - 1];
  if (!node || offset >= node.scope.range.end) return undefined;
  return scopeAt(node.children, offset) ?? node.scope;
}

/** One mapper per dry run; caches decoding and parsing across that worker's tests. */
export function createSourceCoverageMapper({ root, targets }: { root: string; targets: readonly string[] }) {
  const allowed = new Set(targets.map((f) => resolve(f)));
  const sources = new Map<string, SourceInfo>();
  const scripts = new Map<string, { source: string; points: Point[]; complete: boolean }>();

  const local = (name: string, script: string): string => {
    if (name.startsWith('file://')) return fileURLToPath(name);
    if (isAbsolute(name) && allowed.has(resolve(name))) return resolve(name);
    // Vite's root-relative URLs and /@fs/ URLs, plus maps relative to the served module.
    const path = decodeURIComponent(new URL(name, script).pathname);
    if (path.startsWith('/@fs/')) {
      const file = path.slice(5);
      return resolve(isAbsolute(file) ? file : '/' + file);
    }
    return resolve(root, '.' + path);
  };

  const decode = (entry: ScriptCoverage) => {
    const cached = scripts.get(entry.url);
    if (cached && cached.source === entry.source) return cached;
    let complete = true;
    const points: Point[] = [];
    try {
      const match = [...(entry.source ?? '').matchAll(/(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL=(data:application\/json[^\s*]+)/g)].at(-1);
      if (!match) {
        // Unmapped app scripts may contain targets (e.g. bundles). Known vendor
        // and Vite infrastructure scripts do not constrain this source index.
        const path = new URL(entry.url).pathname;
        complete = /\/(?:node_modules|@vite)\//.test(path);
      } else {
        const comma = match[1]!.indexOf(',');
        const uri = match[1]!;
        const json = uri.slice(0, comma).includes(';base64') ? Buffer.from(uri.slice(comma + 1), 'base64').toString() : decodeURIComponent(uri.slice(comma + 1));
        const map = new TraceMap(JSON.parse(json));
        const originals = map.sources.map((name, i) => {
          const file = local((map.sourceRoot ?? '') + name, entry.url);
          if (!allowed.has(file)) return undefined;
          let info = sources.get(file);
          if (!info) {
            const source = readFileSync(file, 'utf8');
            info = { source, lines: starts(source), scopes: tree(instrument(file, source).scopes.filter((scope) => !isTopLevelScope(scope.id))) };
            sources.set(file, info);
          }
          if (map.sourcesContent?.[i] !== info.source) { complete = false; return undefined; }
          return { ...info, file: relative(root, file) };
        });
        if (allowed.has(local(entry.url, entry.url)) && !originals.some(Boolean)) complete = false;
        const generatedLines = starts(entry.source!);
        for (const [line, segments] of decodedMappings(map).entries()) {
          for (const segment of segments) {
            if (segment.length < 4) continue;
            const original = originals[segment[1]!];
            const lineStart = original?.lines[segment[2]!];
            if (!original || lineStart === undefined || generatedLines[line] === undefined) continue;
            const scope = scopeAt(original.scopes, lineStart + segment[3]!);
            if (scope) points.push({ offset: generatedLines[line]! + segment[0], scope: `${original.file}#${scope.id}` });
          }
        }
      }
    } catch {
      complete = false;
    }
    const decoded = { source: entry.source ?? '', points, complete };
    scripts.set(entry.url, decoded);
    return decoded;
  };

  return (entries: readonly ScriptCoverage[]): SourceObservation => {
    const scopes = new Set<string>();
    let complete = true;
    for (const entry of entries) {
      const decoded = decode(entry);
      complete &&= decoded.complete;
      // V8 ranges nest: the innermost range wins, including zero-count child
      // functions inside an executed module or parent function.
      const ranges = entry.functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
      const active: Profiler.CoverageRange[] = [];
      let next = 0;
      for (const point of decoded.points) {
        while (next < ranges.length && ranges[next]!.startOffset <= point.offset) {
          const range = ranges[next++]!;
          while (active.length && active.at(-1)!.endOffset <= range.startOffset) active.pop();
          active.push(range);
        }
        while (active.length && active.at(-1)!.endOffset <= point.offset) active.pop();
        if ((active.at(-1)?.count ?? 0) > 0) scopes.add(point.scope);
      }
    }
    return { scopes: [...scopes].sort(), complete };
  };
}
