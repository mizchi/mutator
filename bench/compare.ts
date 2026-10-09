// Matches our mutants against Stryker's (both mutation-testing-elements JSON reports) on
// file + range + replacement and reports per-mutator counts and verdict disagreements.
// usage: node bench/compare.ts <ours mutation.json> <stryker mutation.json> [--verbose]
import { readFileSync } from 'node:fs';

interface MteMutant {
  id: string;
  mutatorName: string;
  replacement?: string;
  status: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
}

export interface Comparison {
  ours: number;
  stryker: number;
  matched: number;
  onlyOurs: Record<string, number>;
  onlyStryker: Record<string, number>;
  /** matched mutants where one tool detected it and the other did not (Ignored excluded) */
  disagreements: { file: string; line: number; mutator: string; replacement: string; ours: string; stryker: string }[];
  /** score over matched mutants that neither tool ignored */
  sharedScore: { ours: number; stryker: number; n: number };
  perMutator: Record<string, { ours: number; stryker: number; oursDetected: number; strykerDetected: number }>;
}

const DETECTED = new Set(['Killed', 'Timeout', 'RuntimeError', 'CompileError']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);
// Stryker keeps trailing block comments in some replacements (`code === 32 /* */`).
const norm = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();

function load(path: string): (MteMutant & { file: string })[] {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  return Object.entries<{ mutants: MteMutant[] }>(report.files).flatMap(([file, f]) => f.mutants.map((m) => ({ ...m, file })));
}

export function compare(oursPath: string, strykerPath: string): Comparison {
  const ours = load(oursPath);
  const stryker = load(strykerPath);
  const key = (m: MteMutant & { file: string }, replacement = m.replacement ?? '') =>
    `${m.file}:${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column}|${norm(replacement)}`;
  const theirs = new Map(stryker.map((m) => [key(m), m]));
  const matchedKeys = new Set<string>();
  const onlyOurs: Record<string, number> = {};
  const disagreements: Comparison['disagreements'] = [];
  let oursDet = 0;
  let theirDet = 0;
  let n = 0;
  for (const m of ours) {
    // We parenthesize some replacements (`(a && b)`) where Stryker prints `a && b`.
    const rep = m.replacement ?? '';
    const k = [key(m), key(m, rep.replace(/^\(([\s\S]*)\)$/, '$1'))].find((c) => theirs.has(c) && !matchedKeys.has(c));
    const t = k === undefined ? undefined : theirs.get(k);
    if (!t || k === undefined) {
      onlyOurs[m.mutatorName] = (onlyOurs[m.mutatorName] ?? 0) + 1;
      continue;
    }
    matchedKeys.add(k);
    const counted = (s: string) => DETECTED.has(s) || UNDETECTED.has(s);
    if (!counted(m.status) || !counted(t.status)) continue;
    n++;
    if (DETECTED.has(m.status)) oursDet++;
    if (DETECTED.has(t.status)) theirDet++;
    if (DETECTED.has(m.status) !== DETECTED.has(t.status)) {
      disagreements.push({ file: m.file, line: m.location.start.line, mutator: m.mutatorName, replacement: norm(m.replacement ?? '').slice(0, 60), ours: m.status, stryker: t.status });
    }
  }
  const onlyStryker: Record<string, number> = {};
  for (const m of stryker) if (!matchedKeys.has(key(m))) onlyStryker[m.mutatorName] = (onlyStryker[m.mutatorName] ?? 0) + 1;
  const perMutator: Comparison['perMutator'] = {};
  const row = (k: string) => (perMutator[k] ??= { ours: 0, stryker: 0, oursDetected: 0, strykerDetected: 0 });
  for (const m of ours) {
    row(m.mutatorName).ours++;
    if (DETECTED.has(m.status)) row(m.mutatorName).oursDetected++;
  }
  for (const m of stryker) {
    row(m.mutatorName).stryker++;
    if (DETECTED.has(m.status)) row(m.mutatorName).strykerDetected++;
  }
  return {
    ours: ours.length,
    stryker: stryker.length,
    matched: matchedKeys.size,
    onlyOurs,
    onlyStryker,
    disagreements,
    sharedScore: { ours: n ? oursDet / n : 1, stryker: n ? theirDet / n : 1, n },
    perMutator,
  };
}

if (import.meta.main) {
  const [oursPath, strykerPath, flag] = process.argv.slice(2) as [string, string, string?];
  const c = compare(oursPath, strykerPath);
  console.log(`ours ${c.ours}, stryker ${c.stryker}, matched ${c.matched}`);
  console.log('only ours', c.onlyOurs);
  console.log('only stryker', c.onlyStryker);
  console.log(`shared (n=${c.sharedScore.n}): ours ${(c.sharedScore.ours * 100).toFixed(1)}%, stryker ${(c.sharedScore.stryker * 100).toFixed(1)}%`);
  console.log(`verdict disagreements: ${c.disagreements.length}`);
  for (const d of flag === '--verbose' ? c.disagreements : c.disagreements.slice(0, 20)) {
    console.log(`  ${d.file}:${d.line} ${d.mutator} -> ${d.replacement} | ours ${d.ours} / stryker ${d.stryker}`);
  }
}
