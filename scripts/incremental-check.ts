// Checks that incremental runs give the same verdicts as cold runs on real edits.
// usage: node scripts/incremental-check.ts <root> <file> <from> <to> [<file> <from> <to> ...]
// A base snapshot is taken once; for each edit (applied alone, then reverted) an
// incremental run from that snapshot is compared with a cold run of the edited project.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaselineError, type Report, runMutation } from '../packages/cli/src/index.ts';

const [root, ...rest] = process.argv.slice(2) as [string, ...string[]];
const edits: [string, string, string][] = [];
for (let i = 0; i < rest.length; i += 3) edits.push([rest[i]!, rest[i + 1]!, rest[i + 2]!]);

const snap = (name: string) => join(root, '.mutator', `check-${name}.json`);
const verdicts = (r: Report) =>
  new Map(r.entries.map((e) => [`${e.mutant.file.slice(root.length + 1)}:${e.mutant.location.start.line}:${e.mutant.location.start.column} ${e.mutant.original} -> ${e.mutant.replacement}`.replace(/\s+/g, ' '), e.status]));

const base = await runMutation({ root, snapshotPath: snap('base') });
console.log(`base: ${base.entries.length} mutants, ${(base.durationMs / 1000).toFixed(1)}s`);
let mismatches = 0;
for (const [file, from, to] of edits) {
  const path = join(root, file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(from)) throw new Error(`${file}: ${from} not found`);
  writeFileSync(path, original.replace(from, to));
  try {
    copyFileSync(snap('base'), snap('inc'));
    const inc = await runMutation({ root, snapshotPath: snap('inc') }).catch((e: unknown) => {
      if (e instanceof BaselineError) return undefined;
      throw e;
    });
    if (!inc) {
      console.log(`${file}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}\n  skipped: the edit fails the project's tests`);
      continue;
    }
    const cold = await runMutation({ root, snapshotPath: snap(`cold-${Date.now()}`) });
    const a = verdicts(inc);
    const b = verdicts(cold);
    const diff = [...b].filter(([k, s]) => a.get(k) !== s).map(([k, s]) => `  ${k}: incremental ${a.get(k)} / cold ${s}`);
    mismatches += diff.length;
    console.log(`${file}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
    console.log(`  re-collected ${inc.dryRunFiles.length} test files, executed ${inc.executed} (cold ${cold.executed}), ${(inc.durationMs / 1000).toFixed(1)}s vs ${(cold.durationMs / 1000).toFixed(1)}s, mismatches ${diff.length}`);
    for (const line of diff.slice(0, 10)) console.log(line);
  } finally {
    writeFileSync(path, original);
  }
}
console.log(`total mismatches: ${mismatches}`);
process.exitCode = mismatches > 0 ? 1 : 0;
