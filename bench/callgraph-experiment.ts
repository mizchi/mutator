// Same measurement as scripts/callgraph-experiment.ts, plus the project's mutate globs
// (the script mutates src/** — on pathe that includes src/_glob.ts, which crashes the run).
// usage: node bench/callgraph-experiment.ts <root> <include,include...> <file> <from> <to> [<file> <from> <to> ...]
// For each edit: both modes start from their own cold snapshot, the edit is applied,
// and mutants re-run by the sound mode but reused by the call graph mode are checked
// for verdict differences (= what the call graph mode would have missed).
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Report, runMutation } from '../packages/cli/src/index.ts';

const [root, includeArg, ...rest] = process.argv.slice(2) as [string, string, ...string[]];
const include = includeArg.split(',');
const edits: [string, string, string][] = [];
for (let i = 0; i < rest.length; i += 3) edits.push([rest[i]!, rest[i + 1]!, rest[i + 2]!]);

const snap = (name: string) => join(root, '.mutator', `exp-${name}.json`);
const label = (e: Report['entries'][number]) => `${e.mutant.file.slice(root.length + 1)}:${e.mutant.location.start.line} ${e.mutant.original} -> ${e.mutant.replacement}`.replace(/\s+/g, ' ');
const detected = (s: string) => s === 'Killed' || s === 'Timeout' || s === 'RuntimeError';

await runMutation({ root, include, callGraph: false, snapshotPath: snap('cold-false') });
await runMutation({ root, include, callGraph: true, snapshotPath: snap('cold-true') });

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
      const report = await runMutation({ root, include, callGraph, snapshotPath: snap(`work-${callGraph}`) });
      results[String(callGraph)] = { report, ms: performance.now() - t0 };
    }
    const sound = results.false!;
    const graph = results.true!;
    const graphByKey = new Map(graph.report.entries.map((e) => [e.mutant.key, e]));
    const pruned = sound.report.entries.filter((e) => e.source === 'run' && graphByKey.get(e.mutant.key)?.source === 'reuse');
    const missed = pruned.filter((e) => graphByKey.get(e.mutant.key)!.status !== e.status);
    const flips = missed.filter((e) => detected(e.status) !== detected(graphByKey.get(e.mutant.key)!.status));
    console.log(`\n== ${file}: ${from} -> ${to}`);
    console.log(`sound: ran ${sound.report.executed} in ${(sound.ms / 1000).toFixed(1)}s | callgraph: ran ${graph.report.executed} in ${(graph.ms / 1000).toFixed(1)}s | pruned ${pruned.length} | verdict differs ${missed.length} (detected/undetected flips ${flips.length})`);
    for (const e of missed) console.log(`  MISSED ${label(e)}: sound=${e.status} callgraph=${graphByKey.get(e.mutant.key)!.status}`);
  } finally {
    writeFileSync(path, original);
  }
}
// Vitest workers or node:test (defu) may keep the process alive or set exitCode.
process.exit(0);
