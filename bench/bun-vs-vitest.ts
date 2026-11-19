// Benchmark harness: mutator with Vitest vs mutator with Bun's test runner, on the same
// pinned projects and the same test files.
//
// usage: node bench/bun-vs-vitest.ts [--reps 2] [--phase setup,measure] bench/projects/<name>.json...
//
// One clone per project under .tmp/bench-bun/<name> (gitignored), set up like bench/run.ts's
// Vitest clone (bench/lib.ts). The test files import from "vitest"; `bun test` runs them
// unchanged, as Bun maps that import to bun:test.
//
// Measured per runner, `reps` times each: the plain test suite (`vitest run` / `bun test`), a
// cold mutation run, a rerun with no change, and `--since HEAD` after the spec's edit (cold
// snapshot restored). Verdicts of the cold runs are compared mutant by mutant (keys are runner
// independent). Results go to .tmp/bench-bun/results/<name>.json.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type OurCounts, applyEdit, log, parseOurCounts, setupClone, sh, shellQuote } from './lib.ts';
import type { Spec } from './run.ts';

const REPO = resolve(import.meta.dirname, '..');
const WORK = join(REPO, '.tmp', 'bench-bun');
const CLI = join(REPO, 'packages', 'cli', 'src', 'cli.ts');
const VITEST = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).devDependencies.vitest as string;
const RUNNERS = ['vitest', 'bun'] as const;
type Runner = (typeof RUNNERS)[number];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { reps: { type: 'string', default: '2' }, phase: { type: 'string', default: 'setup,measure' } },
});
const reps = Number(values.reps);
const phases = new Set(values.phase.split(','));

function timed(cmd: string, cwd: string): { wallMs: number; result: ReturnType<typeof sh> } {
  const started = performance.now();
  const result = sh(cmd, cwd, true);
  return { wallMs: performance.now() - started, result };
}

const suiteCommand = (runner: Runner) => (runner === 'vitest' ? 'node_modules/.bin/vitest run' : 'bun test');

function mutator(spec: Spec, runner: Runner, extra: string[] = []): string {
  const include = spec.mutate.map((g) => `--include ${shellQuote(g)}`).join(' ');
  return `node ${CLI} --root . --runner ${runner} ${include} --reporter text --reporter json ${extra.join(' ')}`;
}

/** mutant key -> status, from the JSON report. */
function verdicts(dir: string): Map<string, string> {
  const report = JSON.parse(readFileSync(join(dir, '.mutator', 'report', 'mutation.json'), 'utf8'));
  const out = new Map<string, string>();
  for (const file of Object.values(report.files) as { mutants: { id: string; status: string }[] }[]) for (const m of file.mutants) out.set(m.id, m.status);
  return out;
}

/** Tests the plain suite ran, as each runner prints it. */
function testCount(runner: Runner, output: string): number | undefined {
  const m = runner === 'vitest' ? output.match(/Tests\s+(\d+) passed/) : output.match(/Ran (\d+) tests/);
  return m ? Number(m[1]) : undefined;
}

interface Row {
  run: string;
  rep: number;
  wallMs: number;
  exitCode: number | null;
  counts?: OurCounts;
  tests?: number;
  load: number;
}

function measure(spec: Spec, dir: string) {
  const rows: Record<Runner, Row[]> = { vitest: [], bun: [] };
  const cold: Partial<Record<Runner, Map<string, string>>> = {};
  const record = (runner: Runner, run: string, rep: number, cmd: string) => {
    const load = loadavg()[0]!;
    const { wallMs, result } = timed(cmd, dir);
    const output = `${result.stdout}\n${result.stderr}`;
    const row: Row = { run, rep, wallMs, exitCode: result.status, load };
    const counts = parseOurCounts(result.stdout);
    if (counts) row.counts = counts;
    const tests = run === 'suite' ? testCount(runner, output) : undefined;
    if (tests !== undefined) row.tests = tests;
    if (result.status !== 0 && run !== 'suite') log(`${spec.name} ${runner} ${run}: exit ${result.status}\n${output.slice(-2000)}`);
    rows[runner].push(row);
    log(`${spec.name} ${runner} ${run} #${rep}: ${(wallMs / 1000).toFixed(2)}s${counts ? ` (${counts.total} mutants, executed ${counts.executed})` : tests !== undefined ? ` (${tests} tests)` : ''}`);
  };
  // The cold snapshot, kept outside the clone.
  const snapshot = join(WORK, 'state', spec.name);
  for (let rep = 1; rep <= reps; rep++) {
    for (const runner of RUNNERS) {
      record(runner, 'suite', rep, suiteCommand(runner));
      rmSync(join(dir, '.mutator'), { recursive: true, force: true });
      record(runner, 'cold', rep, mutator(spec, runner));
      if (rep === 1) cold[runner] = verdicts(dir);
      rmSync(snapshot, { recursive: true, force: true });
      cpSync(join(dir, '.mutator'), snapshot, { recursive: true });
      record(runner, 'no change', rep, mutator(spec, runner));
      rmSync(join(dir, '.mutator'), { recursive: true, force: true });
      cpSync(snapshot, join(dir, '.mutator'), { recursive: true });
      const revert = applyEdit(dir, spec.edit);
      try {
        record(runner, 'edit --since HEAD', rep, mutator(spec, runner, ['--since', 'HEAD']));
      } finally {
        revert();
      }
    }
  }
  // Verdict agreement on the cold runs.
  const a = cold.vitest!;
  const b = cold.bun!;
  const shared = [...a.keys()].filter((k) => b.has(k));
  const differing = shared.filter((k) => a.get(k) !== b.get(k)).map((k) => ({ key: k, vitest: a.get(k), bun: b.get(k) }));
  return { rows, agreement: { vitestMutants: a.size, bunMutants: b.size, shared: shared.length, differing } };
}

mkdirSync(join(WORK, 'results'), { recursive: true });
const bunVersion = sh('bun --version', REPO).stdout.trim();
for (const path of positionals) {
  const spec = JSON.parse(readFileSync(resolve(path), 'utf8')) as Spec;
  const dir = setupClone(WORK, spec, 'ours', { vitest: VITEST, checks: RUNNERS.map(suiteCommand) });
  if (!phases.has('measure')) continue;
  const result = measure(spec, dir);
  const environment = { cpu: cpus()[0]?.model, cores: availableParallelism(), node: process.version, bun: bunVersion, vitest: spec.vitestOurs ?? VITEST, date: new Date().toISOString() };
  writeFileSync(join(WORK, 'results', `${spec.name}.json`), `${JSON.stringify({ spec: spec.name, environment, ...result }, null, 2)}\n`);
  log(`${spec.name}: ${result.agreement.shared} shared mutants, ${result.agreement.differing.length} verdicts differ`);
}
