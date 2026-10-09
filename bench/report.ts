// Renders .tmp/bench2/results/*.json (written by bench/run.ts) as the markdown tables used
// in docs/benchmark.md.
// usage: node bench/report.ts [<name>...]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compare } from './compare.ts';
import type { Measurement, Spec } from './run.ts';

const WORK = join(resolve(import.meta.dirname, '..'), '.tmp', 'bench2');
const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(join(WORK, 'results'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));

const SCENARIOS: [Measurement['tool'], string, string][] = [
  ['ours', 'cold', 'cold'],
  ['stryker', 'cold', 'cold'],
  ['ours', 'warm', 'no change'],
  ['stryker', 'warm', 'no change (`--incremental`)'],
  ['ours', 'edit-full', 'edit: full run'],
  ['ours', 'edit-since', 'edit: `--since HEAD`'],
  ['ours', 'cold-callgraph', 'cold, `--experimental-callgraph`'],
  ['ours', 'edit-callgraph', 'edit: `--experimental-callgraph`'],
  ['stryker', 'edit', 'edit: `--incremental`'],
];

const s = (ms: number) => (ms / 1000).toFixed(ms < 10_000 ? 2 : 1);
const statusCell = (st: Record<string, number>) =>
  [
    ['K', 'Killed'],
    ['T', 'Timeout'],
    ['RE', 'RuntimeError'],
    ['CE', 'CompileError'],
    ['S', 'Survived'],
    ['NC', 'NoCoverage'],
    ['I', 'Ignored'],
    ['P', 'Pending'],
  ]
    .filter(([, k]) => st[k!])
    .map(([a, k]) => `${a}${st[k!]}`)
    .join(' ');

for (const name of names) {
  const r = JSON.parse(readFileSync(join(WORK, 'results', `${name}.json`), 'utf8')) as {
    spec: Spec;
    ours?: Measurement[];
    stryker?: Measurement[];
    callgraph?: string;
    preflight?: string[];
  };
  console.log(`### ${name} (\`${r.spec.commit.slice(0, 7)}\`)\n`);
  console.log(`Edit: \`${r.spec.edit.file}\` — ${r.spec.edit.note} (${r.spec.edit.kind}).\n`);
  console.log('| scenario | tool | wall s (#1 / #2) | mutants | executed | statuses | score |');
  console.log('|---|---|---|---:|---:|---|---:|');
  for (const [tool, run, label] of SCENARIOS) {
    const ms = (tool === 'ours' ? r.ours : r.stryker)?.filter((m) => m.run === run) ?? [];
    if (ms.length === 0) continue;
    const c = ms.at(-1)!.counts;
    const wall = ms.map((m) => s(m.wallMs)).join(' / ');
    const flag = ms.some((m) => m.exitCode !== 0) ? ' (non-zero exit)' : '';
    const execs = [...new Set(ms.map((m) => m.counts?.executed))].join(' / ');
    const scores = [...new Set(ms.map((m) => (m.counts ? `${(m.counts.score * 100).toFixed(1)}%` : '-')))].join(' / ');
    console.log(`| ${label} | ${tool === 'ours' ? 'mutator' : 'Stryker'} | ${wall}${flag} | ${c?.total ?? '-'} | ${execs} | ${c ? statusCell(c.statuses) : '-'} | ${scores} |`);
  }
  const ours = join(WORK, 'state', name, 'cold-2.mutation.json');
  const theirs = join(WORK, 'state', name, 'stryker-cold-2.mutation.json');
  if (existsSync(ours) && existsSync(theirs)) {
    const c = compare(ours, theirs);
    const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    console.log(
      `\nShared mutants (same file, range and replacement): ${c.matched} of ${c.ours} (ours) / ${c.stryker} (Stryker). ` +
        `Score on the ${c.sharedScore.n} shared, non-ignored mutants: mutator ${(c.sharedScore.ours * 100).toFixed(1)}%, Stryker ${(c.sharedScore.stryker * 100).toFixed(1)}%, ` +
        `${c.disagreements.length} detected/undetected disagreements.`,
    );
    console.log(`Only ours: ${fmt(c.onlyOurs)}. Only Stryker: ${fmt(c.onlyStryker)}.`);
    for (const d of c.disagreements.slice(0, 10)) console.log(`- \`${d.file}:${d.line}\` ${d.mutator} → \`${d.replacement}\`: mutator ${d.ours}, Stryker ${d.stryker}`);
  }
  if (r.callgraph) console.log(`\nCall graph experiment:\n\n\`\`\`\n${r.callgraph}\n\`\`\``);
  if (r.preflight?.length) console.log(`\nPreflight notes:\n${r.preflight.map((p) => `- ${p}`).join('\n')}`);
  console.log();
}
