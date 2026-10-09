// Measures the experimental call graph mode against the sound mode on real edits.
// usage: node scripts/callgraph-experiment.ts <root> <file> <from> <to> [<file> <from> <to> ...]
// For each edit: both modes start from their own cold snapshot, the edit is applied,
// and mutants re-run by the sound mode but reused by the call graph mode are checked
// for verdict differences (= what the call graph mode would have missed).
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Report, runMutation } from '../packages/cli/src/index.ts';

const [root, ...rest] = process.argv.slice(2) as [string, ...string[]];
const edits: [string, string, string][] = [];
for (let i = 0; i < rest.length; i += 3) edits.push([rest[i]!, rest[i + 1]!, rest[i + 2]!]);

const snap = (name: string) => join(root, '.mutator', `exp-${name}.json`);
const label = (e: Report['entries'][number]) => `${e.mutant.file.slice(root.length + 1)}:${e.mutant.location.start.line} ${e.mutant.original} -> ${e.mutant.replacement}`.replace(/\s+/g, ' ');

const cold = async (callGraph: boolean) => runMutation({ root, callGraph, snapshotPath: snap(`cold-${callGraph}`) });
await cold(false);
await cold(true);

for (const [file, from, to] of edits) {
  const path = join(root, file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(from)) throw new Error(`${file}: ${from} not found`);
  writeFileSync(path, original.replace(from, to));
  try {
    const results: Record<string, { report: Report; ms: number }> = {};
    for (const callGraph of [false, true]) {
      copyFileSync(snap(`cold-${callGraph}`), snap(`work-${callGraph}`));
      const t0 = performance.now();
      const report = await runMutation({ root, callGraph, snapshotPath: snap(`work-${callGraph}`) });
      results[String(callGraph)] = { report, ms: performance.now() - t0 };
    }
    const sound = results.false!;
    const graph = results.true!;
    const graphByKey = new Map(graph.report.entries.map((e) => [e.mutant.key, e]));
    const pruned = sound.report.entries.filter((e) => e.source === 'run' && graphByKey.get(e.mutant.key)?.source === 'reuse');
    const missed = pruned.filter((e) => graphByKey.get(e.mutant.key)!.status !== e.status);
    console.log(`\n== ${file}: ${from} -> ${to}`);
    console.log(`sound: ran ${sound.report.executed} in ${(sound.ms / 1000).toFixed(1)}s | callgraph: ran ${graph.report.executed} in ${(graph.ms / 1000).toFixed(1)}s | pruned ${pruned.length} | verdict differs ${missed.length}`);
    for (const e of missed) console.log(`  MISSED ${label(e)}: sound=${e.status} callgraph=${graphByKey.get(e.mutant.key)!.status}`);
  } finally {
    writeFileSync(path, original);
  }
}
